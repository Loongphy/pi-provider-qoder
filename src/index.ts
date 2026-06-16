import type { Api, Model, OAuthCredentials } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setExtensionContext } from "./login-ui.js";
import { getCachedModels, staticModels } from "./models.js";
import { loginQoder, refreshQoderToken } from "./oauth.js";
import { streamQoder } from "./stream.js";
import { fetchQoderUsage } from "./usage.js";

export default function (pi: ExtensionAPI) {
  // Capture ctx for custom TUI login components
  pi.on("session_start", async (_event, ctx) => {
    setExtensionContext(ctx);
  });

  pi.registerProvider("qoder", {
    baseUrl: "https://api3.qoder.sh/",
    api: "qoder-api" as any,
    models: getCachedModels(),
    oauth: {
      name: "Qoder (Browser OAuth / PAT)",
      login: loginQoder,
      refreshToken: refreshQoderToken,
      getApiKey: (cred: OAuthCredentials) => cred.access,
      modifyModels: (models: Model<Api>[], cred: OAuthCredentials) => {
        const cached = getCachedModels();
        const nonQoder = models.filter((m: Model<Api>) => m.provider !== "qoder");
        const modelsToUse = cached.length > 0 ? cached : staticModels;
        const modifiedQoder = modelsToUse.map((m: Model<Api>) => ({
          ...m,
          baseUrl: "https://api3.qoder.sh/",
        }));

        return [...nonQoder, ...modifiedQoder];
      },
      fetchUsage: fetchQoderUsage,
    } as any,
    streamSimple: streamQoder,
  });
}
