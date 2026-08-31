/**
 * Safe UI surface for the streaming layer.
 *
 * Two rules learned the hard way:
 *
 * 1. NEVER write to stderr while pi's interactive TUI owns the terminal.
 *
 *    pi's main-screen renderer tracks the hardware cursor row itself. A raw
 *    `console.error` (text + "\n" at the current cursor position) scrolls the
 *    terminal without the renderer knowing, so every later differential render
 *    writes one row lower than intended — and the more it writes, the more the
 *    drift compounds. The visible result is exactly the reported bug: the
 *    working row ("Working for …" / queue status) re-painted on a new line every
 *    tick, piling up above the composer, and the composer itself pushed off the
 *    bottom of the screen. Reproduced against pi's own TUI with a virtual
 *    terminal: three stderr writes were enough to destroy the editor. So
 *    extension logging is opt-in (QODER_LOG=1) or limited to a non-TTY stderr
 *    (a pipe or a file cannot be corrupted).
 *
 * 2. Do not touch the working row (setWorkingMessage).
 *
 *    pi's working loader is owned by the interactive mode, and common status
 *    extensions retarget it every second ("Working for Xm Ys"). Anything else
 *    writing that slot makes the row flicker between two owners — the other
 *    half of the reported bug. Queue status therefore gets its own dedicated
 *    widget line above the editor (below the working row, pi has no slot above
 *    it), rendered as exactly one truncated line so its height never changes.
 */

/** The part of pi's TUI a widget factory needs. Structural, not imported. */
export interface QoderTui {
  requestRender(force?: boolean): void;
}

/** The part of pi's Theme a widget needs. Structural, not imported. */
export interface QoderTheme {
  fg(color: string, text: string): string;
}

/** The part of pi's Component a widget must satisfy. Structural, not imported. */
export interface QoderWidgetComponent {
  render(width: number): string[];
  invalidate(): void;
  dispose?(): void;
}

export type QoderWidgetFactory = (tui: QoderTui, theme: QoderTheme) => QoderWidgetComponent;

/**
 * Minimal structural view of the pi extension UI context. Declared here (not
 * imported from the coding-agent package) so this module stays loadable in
 * every mode and pi version; anything missing degrades at runtime.
 */
export interface QoderStatusUI {
  setWidget?(
    key: string,
    content: QoderWidgetFactory | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  setWorkingMessage?(message?: string): void;
}

const QUEUE_WIDGET_KEY = "qoder-queue";
/** Leading column, matching pi's own Text widgets (paddingX = 1). */
const QUEUE_WIDGET_PAD_X = 1;

let statusUI: QoderStatusUI | undefined;
let widgetMounted = false;
let widgetTui: QoderTui | undefined;
let widgetTheme: QoderTheme | undefined;
let statusLine: string | undefined;
/**
 * Increments per mount so a stale component's dispose (pi disposes the old
 * widget before creating the new one when the same key is re-mounted) cannot
 * unmount the replacement.
 */
let widgetGeneration = 0;

/** Capture the extension UI context (called from the session_start handler). */
export function setQoderUI(ui: unknown): void {
  statusUI = ui && typeof ui === "object" ? (ui as QoderStatusUI) : undefined;
  // A new interactive session rebuilds its widget container (and disposes our
  // component); drop the mount so the next report re-creates the widget there.
  widgetMounted = false;
  widgetTui = undefined;
  widgetTheme = undefined;
  widgetGeneration++;
}

/** Plain-text truncation for one terminal row. The status line is ASCII/· only. */
function truncateToRow(line: string, width: number): string {
  const max = Math.max(1, width - QUEUE_WIDGET_PAD_X);
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function renderQueueWidget(width: number): string[] {
  if (!statusLine) return [];
  const plain = truncateToRow(statusLine, width);
  // Color AFTER truncating: theme.fg appends invisible ANSI bytes, so the
  // visible width stays `plain.length` and padding stays exact.
  let text = plain;
  try {
    if (typeof widgetTheme?.fg === "function") text = widgetTheme.fg("muted", plain);
  } catch {
    text = plain;
  }
  const pad = Math.max(0, width - QUEUE_WIDGET_PAD_X - plain.length);
  return [`${" ".repeat(QUEUE_WIDGET_PAD_X)}${text}${" ".repeat(pad)}`];
}

function mountQueueWidget(): void {
  if (!statusUI || typeof statusUI.setWidget !== "function") return;
  const generation = ++widgetGeneration;
  try {
    statusUI.setWidget(
      QUEUE_WIDGET_KEY,
      (tui, theme) => {
        widgetTui = tui;
        widgetTheme = theme;
        return {
          render: (width: number) => renderQueueWidget(width),
          invalidate: () => {},
          dispose: () => {
            // pi disposes widgets on session switch / extension reload; the
            // flag makes the next report re-mount instead of updating a ghost.
            if (generation === widgetGeneration) {
              widgetMounted = false;
              widgetTui = undefined;
              widgetTheme = undefined;
            }
          },
        };
      },
      { placement: "aboveEditor" },
    );
    widgetMounted = true;
  } catch {
    widgetMounted = false;
  }
}

/**
 * Show one queue-status line on the dedicated widget row above the editor.
 * Safe to call every tick: the line mutates in place and pi only re-renders.
 */
export function reportQueueStatus(line: string): void {
  statusLine = line;
  if (!statusUI) return;
  if (!widgetMounted) {
    mountQueueWidget();
    if (!widgetMounted && typeof statusUI.setWorkingMessage === "function") {
      // Old pi without widgets: fall back to the working row.
      try {
        statusUI.setWorkingMessage(line);
      } catch {}
    }
    return;
  }
  widgetTui?.requestRender();
}

/** Remove the queue-status row once we are no longer waiting. */
export function clearQueueStatus(): void {
  if (statusLine === undefined && !widgetMounted) return;
  statusLine = undefined;
  if (widgetMounted) {
    widgetMounted = false;
    widgetTui = undefined;
    widgetTheme = undefined;
    widgetGeneration++;
    try {
      statusUI?.setWidget?.(QUEUE_WIDGET_KEY, undefined);
    } catch {}
  } else if (typeof statusUI?.setWorkingMessage === "function") {
    try {
      statusUI.setWorkingMessage(undefined);
    } catch {}
  }
}

function envFlag(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  return !/^(0|false|off)$/i.test(raw.trim());
}

/**
 * stderr logging that cannot corrupt pi's TUI.
 *
 * Default: only when stderr is not a terminal (a pipe or file, where there is
 * no TUI to corrupt). Set QODER_LOG=1 to force it on — e.g. to watch a queue
 * wait from another terminal — accepting that the lines will smear the TUI.
 * QODER_QUEUE_LOG is accepted as an alias.
 */
export function qoderLog(message: string): void {
  const enabled = envFlag("QODER_LOG") ?? envFlag("QODER_QUEUE_LOG") ?? !process.stderr.isTTY;
  if (enabled) console.error(`[pi-provider-qoder] ${message}`);
}
