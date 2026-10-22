import type { Api, Model, OAuthCredentials } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { getQoderBaseUrl, getQoderMode, getQoderUserEmailFallback, isQoderCNMode } from "./cosy.js";
import { getCachedModels, isCacheStale, staticCnModels, staticModels, updateQoderModelsCache } from "./models.js";
import {
  autoLoginQoderFromEnvironment,
  getCachedCredentials,
  loginQoder,
  loginQoderCN,
  refreshQoderToken,
  refreshQoderTokenCN,
} from "./oauth.js";
import { streamQoder } from "./stream.js";
import { qoderLog, setQoderUI } from "./ui.js";
import { fetchQoderUsage, fetchQoderUsageCN } from "./usage.js";

// pi supports a `fetchUsage` hook on the oauth config at runtime, but it is not
// part of the published ProviderConfig type. Declare the extension locally.
type OAuthConfigWithUsage = NonNullable<ProviderConfig["oauth"]> & {
  fetchUsage: (credentials: OAuthCredentials) => Promise<unknown>;
};

const QODER_API = "qoder-api" as Api;

/**
 * pi resolves a custom `api` through a process-wide registry, and
 * `streamSimple()` on the global `pi-ai` entry point needs `qoder-api` to be in
 * it (otherwise `resolveApiProvider` throws "No API provider registered for
 * api: qoder-api"). OMP has no such registry — it imported
 * `@earendil-works/pi-ai/compat` statically here until that broke loading
 * there — so probe the export at runtime: stock pi gets the global registration,
 * OMP falls back to the `registerProvider({ streamSimple })` path below.
 */
async function registerQoderApi(): Promise<void> {
  try {
    const compat = await import("@earendil-works/pi-ai/compat");
    const register = (compat as Record<string, unknown>).registerApiProvider;
    if (typeof register !== "function") return;
    (register as (config: unknown, source: string) => void)(
      { api: QODER_API, stream: streamQoder, streamSimple: streamQoder },
      "provider:qoder",
    );
  } catch {
    // Host has no compat registry; registerProvider(streamSimple) is enough.
  }
}

function modelsForProvider(mode: string, providerID: string): Model<Api>[] {
  const cached = getCachedModels(mode);
  const modelsToUse = cached.length > 0 ? cached : isQoderCNMode(mode) ? staticCnModels : staticModels;

  return modelsToUse.map((m) => ({
    ...m,
    provider: providerID,
    baseUrl: getQoderBaseUrl(mode),
  })) as unknown as Model<Api>[];
}

function createQoderOAuth(providerID: string, mode: string): OAuthConfigWithUsage {
  return {
    name: isQoderCNMode(mode) ? "Qoder CN (PAT)" : "Qoder (Browser OAuth / PAT)",
    login: isQoderCNMode(mode) ? loginQoderCN : loginQoder,
    refreshToken: isQoderCNMode(mode) ? refreshQoderTokenCN : refreshQoderToken,
    getApiKey: (cred: OAuthCredentials) => cred.access,
    modifyModels: (models: Model<Api>[], _cred: OAuthCredentials) => {
      const nonQoder = models.filter((m: Model<Api>) => m.provider !== providerID);
      return [...nonQoder, ...modelsForProvider(mode, providerID)];
    },
    fetchUsage: isQoderCNMode(mode) ? fetchQoderUsageCN : fetchQoderUsage,
  };
}

function registerQoderProvider(pi: ExtensionAPI, providerID: string, mode: string): void {
  const oauth = createQoderOAuth(providerID, mode);
  pi.registerProvider(providerID, {
    baseUrl: getQoderBaseUrl(mode),
    api: QODER_API,
    models: modelsForProvider(mode, providerID) as unknown as ProviderConfig["models"],
    oauth: oauth as ProviderConfig["oauth"],
    streamSimple: streamQoder,
  });
}

async function refreshModelsAtStartup(providerID: string, mode: string): Promise<void> {
  if (!isCacheStale(mode)) return;

  const credentials = getCachedCredentials("", providerID);
  if (!credentials?.access) return;

  await updateQoderModelsCache(
    credentials.access,
    credentials.userID || "qoder-user",
    credentials.name || (isQoderCNMode(mode) ? "Qoder CN User" : "Qoder User"),
    credentials.email || getQoderUserEmailFallback(mode),
    mode,
  );
}

export default async function (pi: ExtensionAPI) {
  await registerQoderApi();

  for (const [providerID, mode] of [
    ["qoder", getQoderMode()],
    ["qoder-cn", "cn"],
  ] as const) {
    try {
      await autoLoginQoderFromEnvironment(providerID, mode);
      // Fire-and-forget: registering the provider below uses the cached model
      // list anyway, so awaiting the network refresh only delayed pi's startup.
      // The next session picks up the refreshed cache.
      void refreshModelsAtStartup(providerID, mode).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        qoderLog(`Model refresh failed for ${providerID}: ${message}`);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // qoderLog, not console.error: extensions load after pi's TUI starts, so
      // a raw stderr write here smears the screen (see ui.ts).
      qoderLog(`Automatic login failed for ${providerID}: ${message}`);
    }
  }

  // Refresh the models cache once per session at startup if it is missing or
  // stale (>1h old), rather than on every message in the stream hot path.
  // Login/refresh are the other rebuild triggers; this covers the case where
  // the cache was deleted while the token is still valid.
  pi.on("session_start", async (_event, ctx) => {
    // Capture the extension UI context so the streaming layer can surface
    // queue/retry status on its own widget row above the editor. Deliberately
    // NOT setWorkingMessage: pi's working loader ("Working for ...") is owned
    // by interactive mode and status extensions, and fighting over that slot
    // makes the row flicker between the two messages every second.
    setQoderUI(ctx.ui);
    for (const [providerID, mode] of [
      ["qoder", getQoderMode()],
      ["qoder-cn", "cn"],
    ] as const) {
      try {
        const accessToken = await ctx.modelRegistry.getApiKeyForProvider(providerID);
        if (!accessToken || !isCacheStale(mode)) continue;
        const creds = getCachedCredentials(accessToken, providerID);
        const userID = creds?.userID || "qoder-user";
        const name = creds?.name || (isQoderCNMode(mode) ? "Qoder CN User" : "Qoder User");
        const email = creds?.email || getQoderUserEmailFallback(mode);
        // Fire-and-forget for the same reason as the startup refresh above;
        // the result only matters for the next session's cache anyway.
        void updateQoderModelsCache(accessToken, userID, name, email, mode).catch(() => {});
      } catch {
        // Best-effort: fall back to the existing cache / static models.
      }
    }
  });

  registerQoderProvider(pi, "qoder", getQoderMode());
  registerQoderProvider(pi, "qoder-cn", "cn");
}
