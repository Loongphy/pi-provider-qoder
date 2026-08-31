/**
 * Safe UI surface for the streaming layer.
 *
 * Three rules learned the hard way:
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
 *
 * 3. Publish the queue line for a widget host that can render it ABOVE
 *    "Working for".
 *
 *    pi renders extension widgets BELOW its working loader, so "above Working
 *    for" is only reachable if a status widget takes the row over while we are
 *    queued. The handshake is two PID-scoped files in the pi agent directory
 *    (both extensions live in one process, so the pid scopes them to this pi
 *    instance and keeps concurrent pi processes out of each other's hair):
 *
 *      qoder-queue-<pid>.json   we write { line, ts } here every status tick
 *                               and unlink it when the queue clears. Consumers
 *                               ignore lines older than 5s (crash leftovers).
 *      qoder-queue-<pid>.claim  a rendering host touches this while it is
 *                               displaying the queue row; fresh mtime (<=3s)
 *                               means "I've got it" and we stand our own widget
 *                               row down so the line is not duplicated.
 *
 *    With no host (no status extension, non-interactive mode), we render the
 *    fallback row ourselves after a short grace period that gives a host time
 *    to claim first.
 */

import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

/**
 * How long we wait before rendering our own fallback row, so a widget host
 * (the user's status extension) can claim the queue row first and render it
 * above "Working for". Only matters when a host exists; without one this is
 * the entire delay before the row appears.
 */
function queueWidgetGraceMs(): number {
  const raw = process.env.QODER_QUEUE_YIELD_GRACE_MS;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.min(parsed, 10_000);
  }
  return 1_200;
}

let statusUI: QoderStatusUI | undefined;
let widgetMounted = false;
let widgetTui: QoderTui | undefined;
let widgetTheme: QoderTheme | undefined;
let statusLine: string | undefined;
/** Set on the first status of a queue episode; reset when the queue clears. */
let episodeStartAt = 0;
/** True once we degraded to setWorkingMessage (old pi without setWidget). */
let usingWorkingMessageFallback = false;
/**
 * Increments per mount so a stale component's dispose (pi disposes the old
 * widget before creating the new one when the same key is re-mounted) cannot
 * unmount the replacement.
 */
let widgetGeneration = 0;

/** The pi agent directory; PI_AGENT_DIR overrides (tests, custom layouts). */
function agentDir(): string {
  return process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/** Both extensions run in one process, so the pid scopes the handshake. */
function queueStatePath(): string {
  return join(agentDir(), `qoder-queue-${process.pid}.json`);
}

function queueClaimPath(): string {
  return join(agentDir(), `qoder-queue-${process.pid}.claim`);
}

/** A host that touched its claim recently is rendering the queue row. */
function consumerActive(): boolean {
  try {
    return Date.now() - statSync(queueClaimPath()).mtimeMs < 3_000;
  } catch {
    return false;
  }
}

/** Publish the current line for widget hosts. Atomic replace, ~100 bytes/tick. */
function publishQueueLine(line: string): void {
  try {
    mkdirSync(agentDir(), { recursive: true });
    const file = queueStatePath();
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ line, ts: Date.now() }));
    renameSync(tmp, file);
  } catch {}
}

function unpublishQueueLine(): void {
  try {
    rmSync(queueStatePath(), { force: true });
  } catch {}
}

/** Capture the extension UI context (called from the session_start handler). */
export function setQoderUI(ui: unknown): void {
  statusUI = ui && typeof ui === "object" ? (ui as QoderStatusUI) : undefined;
  // A new interactive session rebuilds its widget container (and disposes our
  // component); drop the mount so the next report re-creates the widget there.
  unmountQueueWidget();
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

/** Stand our fallback row down (used when cleared and when a host takes over). */
function unmountQueueWidget(): void {
  if (!widgetMounted) return;
  widgetMounted = false;
  widgetTui = undefined;
  widgetTheme = undefined;
  widgetGeneration++;
  try {
    statusUI?.setWidget?.(QUEUE_WIDGET_KEY, undefined);
  } catch {}
}

/**
 * Show one queue-status line. Safe to call every tick.
 *
 * Sink order: the handshake file always carries the line (a widget host may
 * render it above "Working for"); our own fallback row only mounts when no
 * host claimed the job within the grace period.
 */
export function reportQueueStatus(line: string): void {
  statusLine = line;
  if (episodeStartAt === 0) episodeStartAt = Date.now();
  publishQueueLine(line);
  if (!statusUI) return;
  if (consumerActive()) {
    // A host is rendering the row above "Working for" — never duplicate it.
    // Deliberately not even the setWorkingMessage fallback: it would poison
    // pi's workingMessage field, which the host relies on for a seamless
    // restore of "Working for …" once the queue clears.
    unmountQueueWidget();
    return;
  }
  if (!widgetMounted) {
    if (Date.now() - episodeStartAt < queueWidgetGraceMs()) return;
    mountQueueWidget();
    if (!widgetMounted && typeof statusUI.setWorkingMessage === "function") {
      // Old pi without widgets: fall back to the working row.
      usingWorkingMessageFallback = true;
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
  episodeStartAt = 0;
  unpublishQueueLine();
  if (statusLine === undefined && !widgetMounted && !usingWorkingMessageFallback) return;
  statusLine = undefined;
  unmountQueueWidget();
  if (usingWorkingMessageFallback) {
    usingWorkingMessageFallback = false;
    try {
      statusUI?.setWorkingMessage?.(undefined);
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
