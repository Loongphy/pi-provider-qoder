import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import {
  buildAuthHeaders,
  getQoderBaseUrl,
  getQoderMode,
  getQoderModelListURL,
  isQoderCNMode,
  toQoderCNModelId,
} from "./cosy.js";
import { refreshGatewayCosyVersion } from "./cosy-version.js";

export const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/**
 * Maximum output tokens sent per request. Aliyun Model Studio (the upstream
 * behind Qoder's CN catalog) documents Max Output Length = 131072 for every
 * model we expose (qwen3.8-max/flash, qwen3.7-max/plus/flash), in both normal
 * and thinking modes (thinking chain alone goes up to 262144). The Qoder
 * /model/list catalog does not return a per-model output cap, so this single
 * constant is the source of truth for both static models and request sending.
 * qodercli ships a conservative 32e3 default and caps its UI at 65536; we use
 * the documented upstream ceiling so reasoning chains and long generations
 * are not truncated.
 */
export const MAX_OUTPUT_TOKENS = 131072;

/**
 * Fallback context window when the catalog omits `context_config`.
 *
 * Qoder's `/model/list` often ships `max_input_tokens` as a stale 180K floor
 * even for models that accept 1M-token prompts (verified against global `lite`
 * through 1,000K tokens). When `context_config` is present we use its largest
 * `token_count` instead, so models that truly advertise 200K/256K stay there.
 */
export const DEFAULT_CONTEXT_WINDOW = 1000000;

/** Shape of a single entry returned by the Qoder /model/list endpoint. */
export interface QoderModelEntry {
  key?: string;
  enable?: boolean;
  display_name?: string;
  max_input_tokens?: number;
  context_config?: Record<string, { token_count?: number; is_default?: boolean }>;
  is_vl?: boolean;
  is_reasoning?: boolean;
  thinking_config?: {
    disabled?: unknown;
    enabled?: { efforts?: Record<string, { is_default?: boolean }>; is_default?: boolean };
  };
  source?: string;
  [key: string]: unknown;
}

export interface QoderModelDef {
  id: string;
  name: string;
  api: "qoder-api";
  provider: "qoder" | "qoder-cn";
  baseUrl: string;
  reasoning: boolean;
  supportsEffort: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input: ("text" | "image")[];
  cost: typeof ZERO_COST;
  contextWindow: number;
  maxTokens: number;
  description?: string;
}

function getHomeDir(): string {
  // Prefer process.env.HOME so tests can isolate caches. Node 26+ caches
  // os.homedir() from process start, ignoring later HOME changes.
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

function getQoderCachePath(mode?: string): string {
  return join(
    getHomeDir(),
    ".pi",
    "agent",
    isQoderCNMode(mode) ? "qoder-cn-models-cache.json" : "qoder-models-cache.json",
  );
}

interface ParsedModelCache {
  updatedAt?: number;
  models?: QoderModelDef[];
  configs?: Record<string, QoderModelEntry>;
}

/**
 * Model cache parsed once per process, keyed by absolute path (HOME-safe).
 * Every chat request reads the catalog config for its model, so without this
 * the hot path re-read and re-JSON.parses a multi-hundred-KB file per turn.
 * Writers invalidate through writeParsedModelCache(); tests that mutate the
 * cache file directly call clearQoderModelsMemCache().
 */
const modelCacheMem = new Map<string, ParsedModelCache | null>();

/** Clear process-memory model caches (also used by tests that mutate cache files). */
export function clearQoderModelsMemCache(): void {
  modelCacheMem.clear();
}

function readParsedModelCache(mode?: string): ParsedModelCache | null {
  const cachePath = getQoderCachePath(mode);
  if (modelCacheMem.has(cachePath)) {
    return modelCacheMem.get(cachePath) ?? null;
  }
  if (!existsSync(cachePath)) {
    modelCacheMem.set(cachePath, null);
    return null;
  }
  try {
    const data = JSON.parse(readFileSync(cachePath, "utf8")) as ParsedModelCache;
    modelCacheMem.set(cachePath, data);
    return data;
  } catch {
    modelCacheMem.set(cachePath, null);
    return null;
  }
}

function writeParsedModelCache(mode: string, data: ParsedModelCache): void {
  const cachePath = getQoderCachePath(mode);
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(data, null, 2), "utf-8");
  modelCacheMem.set(cachePath, data);
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
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
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
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
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
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
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
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
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
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
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
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "cmodel",
    name: "Cantus (Qoder)",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "qmodel_preview",
    name: "Qwen3.8 Max Preview (Qoder)",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
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
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
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
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
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
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "gm51model",
    name: "GLM 5.2 (Qoder)",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "kmodel",
    name: "Kimi K2.7 Code (Qoder)",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    // The catalog advertises 256K for Kimi; not part of the 1M live test, so
    // it deliberately stays below DEFAULT_CONTEXT_WINDOW.
    contextWindow: 256000,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "kmodel_latest",
    name: "Kimi K3 (Qoder)",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
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
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
];

export const staticCnModels: QoderModelDef[] = [
  {
    id: "Auto",
    name: "Auto",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: true,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 200000,
    maxTokens: MAX_OUTPUT_TOKENS,
    description: "Qoder CN smart routing; fallback context window of 200K.",
  },
  {
    id: "Qwen3.7-Max",
    name: "Qwen3.7-Max",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: true,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
    description: "Qoder CN qmodel_latest; context options 200K/400K/1M.",
  },
  {
    id: "Qwen3.7-Plus",
    name: "Qwen3.7-Plus",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: true,
    supportsEffort: false,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
    description: "Qoder CN qmodel; context options 200K/400K/1M.",
  },
  {
    id: "Qwen3.6-Flash",
    name: "Qwen3.6-Flash",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: true,
    supportsEffort: false,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
    description: "Qoder CN q36fmodel; context options 200K/400K/1M.",
  },
  {
    id: "DeepSeek-V4-Pro",
    name: "DeepSeek-V4-Pro",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: true,
    supportsEffort: false,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
    description: "Qoder CN dmodel; context options 200K/400K/1M.",
  },
  {
    id: "DeepSeek-V4-Flash",
    name: "DeepSeek-V4-Flash",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: false,
    supportsEffort: false,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
    description: "Qoder CN dfmodel; context options 200K/400K/1M.",
  },
  {
    id: "GLM-5.2",
    name: "GLM-5.2",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: true,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 200000,
    maxTokens: MAX_OUTPUT_TOKENS,
    description: "Qoder CN gm51model; live catalog currently displays GLM-5.2 with 200K context.",
  },
  {
    id: "Kimi-K2.7-Code",
    name: "Kimi-K2.7-Code",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: true,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 256000,
    maxTokens: MAX_OUTPUT_TOKENS,
    description: "Qoder CN kmodel; context option 256K.",
  },
  {
    id: "MiniMax-M2.7",
    name: "MiniMax-M2.7",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: false,
    supportsEffort: false,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: 200000,
    maxTokens: MAX_OUTPUT_TOKENS,
    description: "Qoder CN mmodel; live catalog reports 200K context.",
  },
];

/** pi thinking levels in display order (matches the pi-ai SDK this build targets). */
const PI_THINKING_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Map Qoder's `thinking_config` to pi's `thinkingLevelMap` so the TUI exposes
 * the levels the upstream model actually supports.
 *
 * Qoder has two shapes:
 *   - effort-based: `thinking_config.enabled.efforts = { low, medium, xhigh, ... }`
 *     Each effort key is already a pi level name, so supported levels map to
 *     themselves and the rest are pinned to null (hidden in the picker).
 *     `xhigh`/`max` are only shown when the map carries them, otherwise the
 *     picker tops out at `high`.
 *   - toggle-based: `thinking_config.enabled` without `efforts` (only on/off).
 *     Every pi level is exposed and maps to "enabled" so a user picking any
 *     level turns thinking on; the exact effort sent upstream is decided at
 *     request time.
 * Returns undefined for models that do not support thinking, so pi falls back
 * to `reasoning: false`-style behavior (only `off`).
 */
function buildThinkingLevelMap(entry: QoderModelEntry): ThinkingLevelMap | undefined {
  const tc = entry.thinking_config;
  if (!tc) return undefined;
  const efforts = tc.enabled?.efforts;
  if (efforts && typeof efforts === "object") {
    const supported = new Set(Object.keys(efforts));
    // `off` (disable thinking) is selectable when the catalog advertises a
    // `disabled` option; otherwise pin it to null to hide it.
    const map: ThinkingLevelMap = { off: tc.disabled ? "disabled" : null };
    for (const level of PI_THINKING_LEVELS) {
      map[level] = supported.has(level) ? level : null;
    }
    return map;
  }
  // toggle-only (enabled/disabled, no efforts) — expose every level as "on".
  // `off` is selectable when the catalog advertises `disabled`.
  if (tc.enabled) {
    const map: ThinkingLevelMap = { off: tc.disabled ? "disabled" : null };
    for (const level of PI_THINKING_LEVELS) {
      map[level] = "enabled";
    }
    return map;
  }
  return undefined;
}

export function getCachedModels(mode?: string): QoderModelDef[] {
  const data = readParsedModelCache(mode);
  if (data && Array.isArray(data.models)) {
    // Older releases injected `auto` without a corresponding service config.
    // Keep an explicitly enabled service model, but drop the legacy fallback.
    if (data.configs && typeof data.configs === "object" && !data.configs.auto) {
      return data.models.filter((model: QoderModelDef) => model.id !== "auto");
    }
    return data.models;
  }
  return isQoderCNMode(mode) ? staticCnModels : staticModels;
}

export function getCachedModelConfig(modelKey: string, mode?: string): QoderModelEntry | null {
  const data = readParsedModelCache(mode);
  if (data?.configs?.[modelKey]) {
    return withMaxContextAsDefault(data.configs[modelKey] as QoderModelEntry);
  }

  // No cached config. This only happens before the first successful catalog
  // fetch (e.g. not yet logged in), in which case the request cannot succeed
  // anyway. Return a minimal entry carrying the id as the key so callers have
  // something to read; reasoning is unknown so default to false.
  if (isQoderCNMode(mode)) {
    return {
      key: modelKey,
      is_reasoning: false,
      source: "system",
    };
  }

  return null;
}

/**
 * Resolve contextWindow from a catalog entry: the largest `token_count` the
 * entry advertises, otherwise DEFAULT_CONTEXT_WINDOW.
 *
 * Scan from 0, never from the default: seeding with 1M would inflate models
 * that only advertise 200K/256K. `max_input_tokens` is not consulted — in the
 * live catalog it is a stale 180K floor even for models that take 1M prompts.
 * Exported for tests.
 */
export function contextWindowFromCatalog(entry: QoderModelEntry): number {
  const contextConfig = entry.context_config;
  if (contextConfig && typeof contextConfig === "object") {
    let advertised = 0;
    for (const configVal of Object.values(contextConfig)) {
      if (configVal && typeof configVal === "object" && typeof configVal.token_count === "number") {
        if (configVal.token_count > advertised) advertised = configVal.token_count;
      }
    }
    if (advertised > 0) return advertised;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/** Prefer the largest context option when Qoder exposes selectable contexts. */
function withMaxContextAsDefault(entry: QoderModelEntry): QoderModelEntry {
  const contextConfig = entry.context_config;
  if (!contextConfig || typeof contextConfig !== "object") return entry;

  const maxTokenCount = Math.max(
    ...Object.values(contextConfig).map((config) => (typeof config?.token_count === "number" ? config.token_count : 0)),
  );
  if (maxTokenCount <= 0) return entry;

  return {
    ...entry,
    context_config: Object.fromEntries(
      Object.entries(contextConfig).map(([name, config]) => [
        name,
        { ...config, is_default: config.token_count === maxTokenCount },
      ]),
    ),
  };
}

export function isCacheStale(mode?: string): boolean {
  const data = readParsedModelCache(mode);
  if (!data || typeof data.updatedAt !== "number") return true;
  // Stale if older than 1 hour
  return Date.now() - data.updatedAt > 3600_000;
}

export async function updateQoderModelsCache(
  authToken: string,
  userID: string,
  name: string,
  email: string,
  mode: string = getQoderMode(),
): Promise<void> {
  const modelListURL = getQoderModelListURL(mode);
  try {
    // Refresh the dynamic COSY identity BEFORE this request is signed: the
    // gateway gates the catalog on the client's COSY version, so a catalog
    // request signed with a stale identity returns the reduced list, which is
    // then cached for its full TTL and registered for the whole session. The
    // refresh is throttled to once a day (so it returns immediately when not
    // due) and never throws.
    await refreshGatewayCosyVersion();

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

    const resData = (await response.json()) as { chat?: QoderModelEntry[] };
    const chatModels = resData.chat || [];
    if (chatModels.length === 0) return;

    const newModels: QoderModelDef[] = [];
    const configs: Record<string, QoderModelEntry> = {};

    for (const entry of chatModels) {
      const key = entry.key;
      if (!key || !entry.enable) continue;

      const display = entry.display_name || key;
      // Prefer the largest selectable context option the catalog advertises
      // (e.g. 1M when 200K/400K/1M are offered); when it advertises none, use
      // DEFAULT_CONTEXT_WINDOW instead of the stale 180K `max_input_tokens`
      // floor. See contextWindowFromCatalog().
      const ctxLen = contextWindowFromCatalog(entry);
      const isVL = !!entry.is_vl;
      const isReasoning = !!entry.is_reasoning || !!entry.thinking_config;
      const supportsEffort = !!entry.thinking_config?.enabled?.efforts;
      const thinkingLevelMap = buildThinkingLevelMap(entry);
      // CN models expose the upstream display_name (whitespace-stripped) as the
      // pi-visible id; the original `key` is stored in `configs` and read back at
      // request time, so no key<->friendlyId mapping table is needed.
      const modelInfo = isQoderCNMode(mode)
        ? { id: toQoderCNModelId(display), name: display }
        : { id: key, name: display };

      configs[key] = entry;
      if (modelInfo.id !== key) configs[modelInfo.id] = entry;

      newModels.push({
        id: modelInfo.id,
        name: modelInfo.name,
        api: "qoder-api",
        provider: isQoderCNMode(mode) ? "qoder-cn" : "qoder",
        baseUrl: getQoderBaseUrl(mode),
        reasoning: isReasoning,
        supportsEffort,
        thinkingLevelMap,
        input: isVL ? ["text", "image"] : ["text"],
        cost: ZERO_COST,
        contextWindow: ctxLen,
        maxTokens: MAX_OUTPUT_TOKENS,
      });
    }

    if (newModels.length === 0) return;

    const cacheData = {
      updatedAt: Date.now(),
      models: newModels,
      configs,
    };

    writeParsedModelCache(mode, cacheData);
  } catch {}
}
