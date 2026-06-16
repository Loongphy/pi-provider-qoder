import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { buildAuthHeaders } from "./cosy.js";

const CACHE_PATH = join(homedir(), ".pi", "agent", "qoder-models-cache.json");

export const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export interface QoderModelDef {
  id: string;
  name: string;
  api: "qoder-api";
  provider: "qoder";
  baseUrl: string;
  reasoning: boolean;
  supportsEffort: boolean;
  input: ("text" | "image")[];
  cost: typeof ZERO_COST;
  contextWindow: number;
  maxTokens: number;
}

export const staticModels: QoderModelDef[] = [
  {
    id: "auto",
    name: "Qoder Auto",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: true,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 180000,
    maxTokens: 32768,
  },
  {
    id: "ultimate",
    name: "Qoder Ultimate",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "performance",
    name: "Qoder Performance",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "efficient",
    name: "Qoder Efficient",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 180000,
    maxTokens: 32768,
  },
  {
    id: "lite",
    name: "Qoder Lite",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: false,
    supportsEffort: false,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: 180000,
    maxTokens: 32768,
  },
  {
    id: "qmodel",
    name: "Qwen3.7 Plus (Qoder)",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "qmodel_latest",
    name: "Qwen3.7 Max (Qoder)",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "dmodel",
    name: "DeepSeek V4 Pro (Qoder)",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "dfmodel",
    name: "DeepSeek V4 Flash (Qoder)",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gm51model",
    name: "GLM 5.1 (Qoder)",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 180000,
    maxTokens: 32768,
  },
  {
    id: "kmodel",
    name: "Kimi K2.6 (Qoder)",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 256000,
    maxTokens: 32768,
  },
  {
    id: "mmodel",
    name: "MiniMax M3 (Qoder)",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
];

export function getCachedModels(): QoderModelDef[] {
  if (existsSync(CACHE_PATH)) {
    try {
      const data = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
      if (data && Array.isArray(data.models)) {
        return data.models;
      }
    } catch {}
  }
  return staticModels;
}

export function getCachedModelConfig(modelKey: string): Record<string, any> | null {
  if (existsSync(CACHE_PATH)) {
    try {
      const data = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
      if (data && data.configs && data.configs[modelKey]) {
        return data.configs[modelKey];
      }
    } catch {}
  }
  return null;
}

export function isCacheStale(): boolean {
  if (!existsSync(CACHE_PATH)) return true;
  try {
    const data = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    if (!data || typeof data.updatedAt !== "number") return true;
    // Stale if older than 1 hour
    return Date.now() - data.updatedAt > 3600_000;
  } catch {
    return true;
  }
}

export async function updateQoderModelsCache(
  authToken: string,
  userID: string,
  name: string,
  email: string,
): Promise<void> {
  const modelListURL = "https://api3.qoder.sh/algo/api/v2/model/list";
  try {
    const headers = buildAuthHeaders(null, modelListURL, {
      userID,
      authToken,
      name,
      email,
    });

    const response = await fetch(modelListURL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...headers,
      },
    });

    if (!response.ok) {
      return;
    }

    const resData = (await response.json()) as { chat?: any[] };
    const chatModels = resData.chat || [];
    if (chatModels.length === 0) return;

    const newModels: QoderModelDef[] = [];
    const configs: Record<string, any> = {};

    for (const entry of chatModels) {
      const key = entry.key;
      if (!key || !entry.enable) continue;

      const display = entry.display_name || key;
      let ctxLen = entry.max_input_tokens || 180000;
      if (entry.context_config && typeof entry.context_config === "object") {
        for (const configVal of Object.values(entry.context_config)) {
          if (configVal && typeof configVal === "object" && typeof (configVal as any).token_count === "number") {
            const tc = (configVal as any).token_count;
            if (tc > ctxLen) {
              ctxLen = tc;
            }
          }
        }
      }
      const isVL = !!entry.is_vl;
      const isReasoning = !!entry.is_reasoning || !!entry.thinking_config;
      const supportsEffort = !!entry.thinking_config?.enabled?.efforts;

      configs[key] = entry;

      newModels.push({
        id: key,
        name: display,
        api: "qoder-api",
        provider: "qoder",
        baseUrl: "https://api3.qoder.sh/",
        reasoning: isReasoning,
        supportsEffort,
        input: isVL ? ["text", "image"] : ["text"],
        cost: ZERO_COST,
        contextWindow: ctxLen,
        maxTokens: entry.max_output_tokens || 32768,
      });
    }

    if (newModels.length === 0) return;

    // Ensure auto is present
    if (!newModels.some((m) => m.id === "auto")) {
      newModels.unshift({
        id: "auto",
        name: "Qoder Auto",
        api: "qoder-api",
        provider: "qoder",
        baseUrl: "https://api3.qoder.sh/",
        reasoning: true,
        supportsEffort: false,
        input: ["text", "image"],
        cost: ZERO_COST,
        contextWindow: 180000,
        maxTokens: 32768,
      });
    }

    const cacheData = {
      updatedAt: Date.now(),
      models: newModels,
      configs,
    };

    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(cacheData, null, 2), "utf-8");
  } catch {}
}
