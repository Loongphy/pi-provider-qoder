import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

export type LoginChoice = { method: "web" } | null; // cancelled

let _ctx: ExtensionContext | undefined;

export function setExtensionContext(ctx: ExtensionContext) {
  _ctx = ctx;
}

export function hasExtensionContext(): boolean {
  return _ctx !== undefined;
}

/**
 * Show the login selection UI using pi's native TUI components.
 * Returns the user's choice or null if cancelled.
 */
export async function showLoginUI(): Promise<LoginChoice> {
  if (!_ctx) return null;
  const ctx = _ctx;

  return ctx.ui.custom<LoginChoice>((tui, theme, _kb, done) => {
    const mainItems: SelectItem[] = [
      { value: "web", label: "Browser Login", description: "Sign in via browser (OAuth device flow)" },
    ];

    const container = new Container();
    const border = new DynamicBorder((s: string) => theme.fg("accent", s));
    const title = new Text(theme.fg("accent", theme.bold("Qoder Login")), 1, 0);
    const hint = new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0);
    const borderBottom = new DynamicBorder((s: string) => theme.fg("accent", s));

    const selectList = new SelectList(mainItems, mainItems.length, {
      selectedPrefix: (t: string) => theme.fg("accent", t),
      selectedText: (t: string) => theme.fg("accent", t),
      description: (t: string) => theme.fg("muted", t),
      scrollInfo: (t: string) => theme.fg("dim", t),
      noMatch: (t: string) => theme.fg("warning", t),
    });

    selectList.onSelect = (item) => {
      done({ method: item.value as "web" });
    };
    selectList.onCancel = () => done(null);

    container.addChild(border);
    container.addChild(title);
    container.addChild(selectList);
    container.addChild(hint);
    container.addChild(borderBottom);

    tui.requestRender();

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

/**
 * Show a waiting UI wrapper with an Escape return loop logic.
 * The user can press Escape or 'q' to abort the current login flow immediately.
 */
export async function showWaitingUI(
  outerCallbacks: OAuthLoginCallbacks,
  runAuth: (mergedCallbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials>,
): Promise<OAuthCredentials | null> {
  if (!_ctx) {
    return runAuth(outerCallbacks);
  }
  const ctx = _ctx;

  return ctx.ui.custom<OAuthCredentials | null>((tui, theme, _kb, done) => {
    const container = new Container();
    const border = new DynamicBorder((s: string) => theme.fg("accent", s));
    const title = new Text(theme.fg("accent", theme.bold("Qoder Login - Authorization")), 1, 0);
    const borderBottom = new DynamicBorder((s: string) => theme.fg("accent", s));

    const statusText = new Text("Initiating login flow...", 1, 0);
    const urlText = new Text("", 1, 0);
    const instructionsText = new Text("", 1, 0);
    const hint = new Text(theme.fg("dim", "esc cancel / back"), 1, 0);

    container.addChild(border);
    container.addChild(title);
    container.addChild(statusText);
    container.addChild(urlText);
    container.addChild(instructionsText);
    container.addChild(hint);
    container.addChild(borderBottom);

    const abortCtrl = new AbortController();
    let onAuthCalled = false;

    const mergedCallbacks: OAuthLoginCallbacks = {
      ...outerCallbacks,
      onProgress: (msg: string) => {
        outerCallbacks.onProgress?.(msg);
        statusText.setText(msg);
        tui.requestRender();
      },
      onAuth: (info: { url: string; instructions?: string }) => {
        if (!onAuthCalled) {
          onAuthCalled = true;
          outerCallbacks.onAuth?.(info);
        }
        urlText.setText(`URL: ${info.url}`);
        instructionsText.setText(info.instructions || "");
        tui.requestRender();
      },
      signal: abortCtrl.signal,
    };

    runAuth(mergedCallbacks).then(
      (creds) => {
        done(creds);
      },
      (err) => {
        if (abortCtrl.signal.aborted) {
          done(null);
        } else {
          statusText.setText(theme.fg("warning", `Error: ${err.message || err}`));
          tui.requestRender();
          setTimeout(() => done(null), 3000);
        }
      },
    );

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        // Escape key (standalone 0x1B) or 'q' to cancel
        if ((data.length === 1 && data.charCodeAt(0) === 0x1b) || data === "q") {
          abortCtrl.abort();
          done(null);
        }
      },
    };
  });
}
