import type { Api, Model, OAuthCredentials } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { getCachedModels, isCacheStale, staticModels, updateQoderModelsCache } from "./models.js";
import { getCachedCredentials, loginQoder, refreshQoderToken } from "./oauth.js";
import { streamQoder } from "./stream.js";
import { fetchQoderUsage } from "./usage.js";

// pi supports a `fetchUsage` hook on the oauth config at runtime, but it is not
// part of the published ProviderConfig type. Declare the extension locally.
type OAuthConfigWithUsage = NonNullable<ProviderConfig["oauth"]> & {
  fetchUsage: typeof fetchQoderUsage;
};

export default function (pi: ExtensionAPI) {
  // Refresh the models cache once per session at startup if it is missing or
  // stale (>1h old), rather than on every message in the stream hot path.
  // Login/refresh are the other rebuild triggers; this covers the case where
  // the cache was deleted while the token is still valid.
  pi.on("session_start", async (_event, ctx) => {
    try {
      const accessToken = await ctx.modelRegistry.getApiKeyForProvider("qoder");
      if (!accessToken || !isCacheStale()) return;
      const creds = getCachedCredentials(accessToken);
      const userID = creds?.userID || "qoder-user";
      const name = creds?.name || "Qoder User";
      const email = creds?.email || "user@qoder.com";
      await updateQoderModelsCache(accessToken, userID, name, email);
    } catch {
      // Best-effort: fall back to the existing cache / static models.
    }
  });

  const oauth: OAuthConfigWithUsage = {
    name: "Qoder (Browser OAuth / PAT)",
    login: loginQoder,
    refreshToken: refreshQoderToken,
    getApiKey: (cred: OAuthCredentials) => cred.access,
    modifyModels: (models: Model<Api>[], _cred: OAuthCredentials) => {
      const cached = getCachedModels();
      const nonQoder = models.filter((m: Model<Api>) => m.provider !== "qoder");
      const modelsToUse = cached.length > 0 ? cached : staticModels;
      const modifiedQoder = modelsToUse.map((m) => ({
        ...m,
        baseUrl: "https://api3.qoder.sh/",
      })) as Model<Api>[];

      return [...nonQoder, ...modifiedQoder];
    },
    fetchUsage: fetchQoderUsage,
  };

  pi.registerProvider("qoder", {
    baseUrl: "https://api3.qoder.sh/",
    api: "qoder-api" as Api,
    models: getCachedModels() as unknown as ProviderConfig["models"],
    oauth: oauth as ProviderConfig["oauth"],
    streamSimple: streamQoder,
  });
}
