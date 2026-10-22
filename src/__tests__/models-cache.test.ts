import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCosyVersionMemCache, getGatewayCosyVersion } from "../cosy-version.js";
import { clearQoderModelsMemCache, getCachedModelConfig, getCachedModels, updateQoderModelsCache } from "../models.js";

// These suites exercise the real ~/.pi/agent caches, so every file is backed
// up and restored, and the process-memory caches are dropped between tests —
// otherwise a cache parsed in one test leaks into the next and the suite
// becomes order-dependent.
const testHome = () => process.env.HOME || process.env.USERPROFILE || homedir();
const CACHE_PATH = join(testHome(), ".pi", "agent", "qoder-models-cache.json");
const VERSION_CACHE_PATH = join(testHome(), ".pi", "agent", "qoder-cosy-version-cache.json");
let originalCache: string | undefined;
let originalVersionCache: string | undefined;

function clearMemCaches(): void {
  clearQoderModelsMemCache();
  clearCosyVersionMemCache();
}

/**
 * Catalog stub that is aware of the two URLs updateQoderModelsCache hits: the
 * CLI releases feed (COSY identity refresh) must not consume the catalog
 * response, and nothing here may reach the real network.
 */
function stubCatalogFetch(chat: unknown[], releases: unknown[] = []) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: unknown) => {
    const target = String(url);
    if (target.includes("repo.qoder.com")) {
      calls.push("releases");
      return { ok: true, status: 200, json: async () => releases };
    }
    calls.push("catalog");
    return { ok: true, status: 200, json: async () => ({ chat }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

beforeEach(() => {
  originalCache = existsSync(CACHE_PATH) ? readFileSync(CACHE_PATH, "utf8") : undefined;
  originalVersionCache = existsSync(VERSION_CACHE_PATH) ? readFileSync(VERSION_CACHE_PATH, "utf8") : undefined;
  rmSync(CACHE_PATH, { force: true });
  rmSync(VERSION_CACHE_PATH, { force: true });
  clearMemCaches();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalCache === undefined) rmSync(CACHE_PATH, { force: true });
  else writeFileSync(CACHE_PATH, originalCache, "utf8");
  if (originalVersionCache === undefined) rmSync(VERSION_CACHE_PATH, { force: true });
  else writeFileSync(VERSION_CACHE_PATH, originalVersionCache, "utf8");
  clearMemCaches();
});

describe("Qoder model cache", () => {
  it("refreshes the COSY version before signing the catalog request", async () => {
    const { calls } = stubCatalogFetch(
      [{ key: "lite", enable: true, display_name: "Lite" }],
      [{ tag_name: "1.1.99", draft: false, prerelease: false }],
    );

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");

    // The catalog must be signed with the version the refresh just fetched
    // (1.1.99, ahead of the bundled fallback): a stale identity makes the
    // gateway return the reduced list, which is then cached for its full TTL.
    expect(calls).toEqual(["releases", "catalog"]);
    expect(getGatewayCosyVersion()).toBe("1.1.99");
    expect(getCachedModels("global").map((model) => model.id)).toEqual(["lite"]);
  });

  it("keeps only enabled service models without adding auto as a fallback", async () => {
    stubCatalogFetch([
      { key: "auto", enable: false, display_name: "Auto" },
      { key: "ultimate", enable: true, display_name: "Ultimate", is_reasoning: true },
      { key: "lite", enable: true, display_name: "Lite" },
      { key: "performance", enable: false, display_name: "Performance" },
    ]);

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");

    const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    expect(cache.models.map((model: { id: string }) => model.id)).toEqual(["ultimate", "lite"]);
    expect(cache.models.some((model: { id: string }) => model.id === "auto")).toBe(false);
  });

  it("keeps the Cantus model returned by the current catalog", async () => {
    stubCatalogFetch([{ key: "cmodel", enable: true, display_name: "Cantus" }]);

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");

    const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    expect(cache.models.map((model: { id: string }) => model.id)).toEqual(["cmodel"]);
  });

  it("filters auto from a legacy fallback cache when the service did not enable it", () => {
    writeFileSync(
      CACHE_PATH,
      JSON.stringify({
        updatedAt: Date.now(),
        models: [{ id: "auto" }, { id: "ultimate" }],
        configs: { ultimate: { key: "ultimate", enable: true } },
      }),
      "utf8",
    );
    clearMemCaches();

    expect(getCachedModels("global").map((model) => model.id)).toEqual(["ultimate"]);
  });

  it("serves reads from memory after the cache file is removed", async () => {
    stubCatalogFetch([{ key: "lite", enable: true, display_name: "Lite" }]);

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");
    expect(getCachedModelConfig("lite", "global")?.key).toBe("lite");

    // Hot-path reads must keep working without touching disk again.
    rmSync(CACHE_PATH, { force: true });
    expect(existsSync(CACHE_PATH)).toBe(false);
    expect(getCachedModelConfig("lite", "global")?.key).toBe("lite");
    expect(getCachedModels("global").map((model) => model.id)).toEqual(["lite"]);
  });

  it("records a 1M context window when the catalog omits context_config", async () => {
    stubCatalogFetch([{ key: "lite", enable: true, display_name: "Lite", max_input_tokens: 180000 }]);

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");

    const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    expect(cache.models[0].contextWindow).toBe(1_000_000);
  });

  it("records the advertised context_config max, even when it is below 1M", async () => {
    stubCatalogFetch([
      {
        key: "gm51model",
        enable: true,
        display_name: "GLM 5.2",
        context_config: { default: { token_count: 200000, is_default: true } },
      },
    ]);

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");

    const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    expect(cache.models[0].contextWindow).toBe(200000);
  });

  it("exposes the max thinking effort only when the catalog advertises it", async () => {
    stubCatalogFetch([
      {
        key: "efforty",
        enable: true,
        display_name: "Efforty",
        thinking_config: { enabled: { efforts: { low: {}, max: {} } } },
      },
      {
        key: "toggle",
        enable: true,
        display_name: "Toggler",
        thinking_config: { disabled: {}, enabled: { is_default: true } },
      },
    ]);

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");

    const models = getCachedModels("global");
    // Effort maps gain the `max` entry; toggle maps keep mapping every level to
    // "enabled", so the wire payload for toggle-only models is unchanged.
    expect(models[0].thinkingLevelMap).toMatchObject({ low: "low", max: "max", high: null });
    expect(models[1].thinkingLevelMap).toMatchObject({ max: "enabled", xhigh: "enabled" });
  });
});
