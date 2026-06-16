import type { Api, Model, OAuthCredentials } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { getCachedModels, staticModels } from "./models.js";
import { loginQoder, refreshQoderToken } from "./oauth.js";
import { streamQoder } from "./stream.js";
import { fetchQoderUsage } from "./usage.js";

// pi supports a `fetchUsage` hook on the oauth config at runtime, but it is not
// part of the published ProviderConfig type. Declare the extension locally.
type OAuthConfigWithUsage = NonNullable<ProviderConfig["oauth"]> & {
  fetchUsage: typeof fetchQoderUsage;
};

export default function (pi: ExtensionAPI) {
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
