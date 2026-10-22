import crypto from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAuthHeaders,
  getQoderBaseUrl,
  getQoderCenterUrl,
  getQoderChatURL,
  getQoderExchangeURL,
  getQoderManageUrl,
  getQoderMode,
  getQoderModelListURL,
  getQoderOpenApiUrl,
  getQoderRefreshURL,
  getQoderUsageURL,
  getQoderUserEmailFallback,
  getQoderUserInfoURL,
  isQoderCNMode,
  toQoderCNModelId,
} from "../cosy.js";
import { BUNDLED_GATEWAY_COSY_VERSION, clearCosyVersionMemCache } from "../cosy-version.js";

// ── getQoderMode ──────────────────────────────────────────────────────────

describe("getQoderMode", () => {
  it('returns "cn" for explicit CN variants', () => {
    expect(getQoderMode("cn")).toBe("cn");
    expect(getQoderMode("china")).toBe("cn");
    expect(getQoderMode("qodercn")).toBe("cn");
    expect(getQoderMode("qoder-cn")).toBe("cn");
    expect(getQoderMode("CN")).toBe("cn");
    expect(getQoderMode("China")).toBe("cn");
  });

  it('returns "global" for explicit global variants', () => {
    expect(getQoderMode("global")).toBe("global");
    expect(getQoderMode("intl")).toBe("global");
    expect(getQoderMode("international")).toBe("global");
    expect(getQoderMode("qoder")).toBe("global");
  });

  it("falls back to global for unknown strings", () => {
    expect(getQoderMode("unknown")).toBe("global");
    expect(getQoderMode("")).toBe("global");
  });
});

// ── isQoderCNMode ─────────────────────────────────────────────────────────

describe("isQoderCNMode", () => {
  it("returns true for CN modes", () => {
    expect(isQoderCNMode("cn")).toBe(true);
    expect(isQoderCNMode("china")).toBe(true);
  });

  it("returns false for global modes", () => {
    expect(isQoderCNMode("global")).toBe(false);
    expect(isQoderCNMode("intl")).toBe(false);
  });
});

// ── URL builders ──────────────────────────────────────────────────────────

describe("getQoderBaseUrl", () => {
  it("returns CN URL for cn mode", () => {
    expect(getQoderBaseUrl("cn")).toBe("https://gateway.qoder.com.cn/");
  });

  it("returns global URL for global mode", () => {
    expect(getQoderBaseUrl("global")).toBe("https://api3.qoder.sh/");
  });
});

describe("getQoderOpenApiUrl", () => {
  it("returns CN URL for cn mode", () => {
    expect(getQoderOpenApiUrl("cn")).toBe("https://openapi.qoder.com.cn");
  });

  it("returns global URL for global mode", () => {
    expect(getQoderOpenApiUrl("global")).toBe("https://openapi.qoder.sh");
  });
});

describe("getQoderCenterUrl", () => {
  it("returns CN URL for cn mode", () => {
    expect(getQoderCenterUrl("cn")).toBe("https://gateway.qoder.com.cn");
  });

  it("returns global URL for global mode", () => {
    expect(getQoderCenterUrl("global")).toBe("https://center.qoder.sh");
  });
});

describe("getQoderModelListURL", () => {
  it("constructs correct CN URL", () => {
    expect(getQoderModelListURL("cn")).toBe("https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1");
  });

  it("constructs correct global URL", () => {
    expect(getQoderModelListURL("global")).toBe("https://api3.qoder.sh/algo/api/v2/model/list?Encode=1");
  });
});

describe("getQoderChatURL", () => {
  it("contains base URL and chat path", () => {
    const url = getQoderChatURL("global");
    expect(url).toContain("https://api3.qoder.sh/");
    expect(url).toContain("algo/api/v2/service/pro/sse/agent_chat_generation");
    expect(url).toContain("Encode=1");
  });
});

describe("getQoderExchangeURL", () => {
  it("constructs correct CN URL", () => {
    expect(getQoderExchangeURL("cn")).toBe("https://openapi.qoder.com.cn/api/v1/jobToken/exchange");
  });

  it("constructs correct global URL", () => {
    expect(getQoderExchangeURL("global")).toBe("https://openapi.qoder.sh/api/v1/jobToken/exchange");
  });
});

describe("getQoderUserInfoURL", () => {
  it("constructs correct URL", () => {
    expect(getQoderUserInfoURL("global")).toBe("https://openapi.qoder.sh/api/v1/userinfo");
  });
});

describe("getQoderUsageURL", () => {
  it("constructs correct URL", () => {
    expect(getQoderUsageURL("global")).toBe("https://openapi.qoder.sh/api/v2/quota/usage");
  });
});

describe("getQoderRefreshURL", () => {
  it("constructs correct CN URL", () => {
    expect(getQoderRefreshURL("cn")).toBe("https://gateway.qoder.com.cn/algo/api/v3/user/refresh_token");
  });

  it("constructs correct global URL", () => {
    expect(getQoderRefreshURL("global")).toBe("https://center.qoder.sh/algo/api/v3/user/refresh_token");
  });
});

describe("getQoderManageUrl", () => {
  it("returns CN URL", () => {
    expect(getQoderManageUrl("cn")).toBe("https://qoder.com.cn");
  });

  it("returns global URL", () => {
    expect(getQoderManageUrl("global")).toBe("https://qoder.com");
  });
});

describe("getQoderUserEmailFallback", () => {
  it("returns CN email", () => {
    expect(getQoderUserEmailFallback("cn")).toBe("user@qoder.com.cn");
  });

  it("returns global email", () => {
    expect(getQoderUserEmailFallback("global")).toBe("user@qoder.com");
  });
});

// ── toQoderCNModelId ──────────────────────────────────────────────────────

describe("toQoderCNModelId", () => {
  it("strips whitespace from the upstream display_name", () => {
    // The display name is used directly as the pi-visible model id, with
    // whitespace removed so it stays a clean token for persistence keys and
    // search. "Qwen3.8-Flash" has no spaces already.
    expect(toQoderCNModelId("Qwen3.8-Flash")).toBe("Qwen3.8-Flash");
  });

  it("collapses internal spaces", () => {
    expect(toQoderCNModelId("Qwen 3.8 Max")).toBe("Qwen3.8Max");
    expect(toQoderCNModelId("DeepSeek V4 Pro")).toBe("DeepSeekV4Pro");
  });

  it("falls back to a default when no display name is given", () => {
    expect(toQoderCNModelId()).toBe("QoderCNModel");
    expect(toQoderCNModelId("")).toBe("QoderCNModel");
  });
});

// ── buildAuthHeaders: COSY client identity + signature ────────────────────

const CHAT_URL = "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation";
const CN_LIST_URL = "https://gateway.qoder.com.cn/algo/api/v2/model/list";

const CREDS = {
  userID: "user-1",
  authToken: "token-1",
  name: "Test",
  email: "test@example.com",
  machineID: "machine-1",
};

/** Pinned COSY-Key produced by the mocked RSA step below. */
const FAKE_COSY_KEY_B64 = "ZmFrZS1yc2EtZW5jcnlwdGVkLWFlcy1rZXktbWF0ZXJpYWwhIQ==";
/** Payload of the pinned vectors: version v1, requestId 11111111-…, cosyVersion 1.1.72. */
const PINNED_PAYLOAD_B64 =
  "eyJ2ZXJzaW9uIjoidjEiLCJyZXF1ZXN0SWQiOiIxMTExMTExMS0yMjIyLTMzMzMtNDQ0NC01NTU1NTU1NTU1NTUiLC" +
  "JpbmZvIjoiQVJCazBIR3o2SUx6cG9NT0l6OVRmNUZsWjBxNUpxN3NwSWwyOXQ1Nll2WndpUDZmSE5yOU1VNkxlWVpi" +
  "ZE5tZHdXQ1k5dGZUNG1qeHNLNGliVWdHU0txRER5KzZWQlYrMllzdjhZTlhxOWpwQjFLWEUrejEwN1BIS2JCTFdUUk" +
  "hrUjN1T1dGajlFcEo0QVRJSHhjTTB3PT0iLCJjb3N5VmVyc2lvbiI6IjEuMS43MiIsImlkZVZlcnNpb24iOiIifQ==";

/**
 * Signature vectors recorded from the pre-refactor implementation (which
 * hashed one concatenated template string). The refactor to a chained MD5
 * pass must keep producing these exact bytes.
 */
const PINNED_VECTORS: {
  label: string;
  url: string;
  body: Buffer | string | null;
  sig: string;
  bodyhash: string;
  bodylen: string;
}[] = [
  {
    label: "no body",
    url: CHAT_URL,
    body: null,
    sig: "a7a6b1c1287c3690c30e8f21f9900233",
    bodyhash: "d41d8cd98f00b204e9800998ecf8427e",
    bodylen: "0",
  },
  {
    label: "json buffer",
    url: CHAT_URL,
    body: Buffer.from('{"hello":"world","n":1}', "utf8"),
    sig: "2a686f35f374c31c004d100920fa6cb4",
    bodyhash: "31c80eba4a1b0f6cab9c72d35cc63a6a",
    bodylen: "23",
  },
  {
    label: "multibyte buffer",
    url: CHAT_URL,
    body: Buffer.from("héllo wörld ünïcode 你好 🚀", "utf8"),
    sig: "3c96c79a217dea5a308169a37751b960",
    bodyhash: "303e2189c5b737d94d5ed53467dee5c6",
    bodylen: "35",
  },
  {
    label: "string body",
    url: CHAT_URL,
    body: "plain string body",
    sig: "ac4cb4b9bce26bc990a3e66b5fe7a35a",
    bodyhash: "847060da2a8246e9a554fa382a5cf647",
    bodylen: "17",
  },
  {
    label: "CN catalog GET",
    url: CN_LIST_URL,
    body: null,
    sig: "f794ca95567d0bb4da200df83b254f6c",
    bodyhash: "d41d8cd98f00b204e9800998ecf8427e",
    bodylen: "0",
  },
];

describe("buildAuthHeaders COSY identity", () => {
  let testHome: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    // Sign with an isolated HOME so the dynamic identity is deterministic: an
    // empty cache directory means the bundled fallback is what gets signed.
    savedHome = process.env.HOME;
    testHome = mkdtempSync(join(tmpdir(), "qoder-cosy-"));
    process.env.HOME = testHome;
    clearCosyVersionMemCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearCosyVersionMemCache();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(testHome, { recursive: true, force: true });
  });

  /** Make every random input of a signature reproducible. */
  function pinRandomness(): void {
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee") // aes key source
      .mockReturnValueOnce("11111111-2222-3333-4444-555555555555") // requestId
      .mockReturnValueOnce("99999999-8888-7777-6666-555555555555"); // X-Request-Id
    // RSA PKCS#1 v1.5 padding is random per call, so the COSY-Key — and with
    // it the signature — is only reproducible once this step is pinned.
    vi.spyOn(crypto, "publicEncrypt").mockReturnValue(Buffer.from(FAKE_COSY_KEY_B64, "base64"));
    vi.spyOn(Date, "now").mockReturnValue(1700000000000);
  }

  function signedPayload(headers: Record<string, string>): { cosyVersion: string } {
    const payloadB64 = headers.Authorization.slice("Bearer COSY.".length).split(".")[0];
    return JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8")) as { cosyVersion: string };
  }

  it("sends the bundled qodercli identity as Cosy-Version and cosyVersion", () => {
    expect(BUNDLED_GATEWAY_COSY_VERSION).toBe("1.1.72");
    const headers = buildAuthHeaders(null, CN_LIST_URL, CREDS);
    expect(headers["Cosy-Version"]).toBe(BUNDLED_GATEWAY_COSY_VERSION);
    expect(signedPayload(headers).cosyVersion).toBe(BUNDLED_GATEWAY_COSY_VERSION);
  });

  it("signs with a cached CLI release ahead of the bundled fallback", () => {
    mkdirSync(join(testHome, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(testHome, ".pi", "agent", "qoder-cosy-version-cache.json"),
      JSON.stringify({ version: "1.1.99", checkedAt: Date.now() }),
      "utf8",
    );
    clearCosyVersionMemCache();

    const headers = buildAuthHeaders(null, CN_LIST_URL, CREDS);
    expect(headers["Cosy-Version"]).toBe("1.1.99");
    expect(signedPayload(headers).cosyVersion).toBe("1.1.99");
  });

  it.each(PINNED_VECTORS)("pins the signature bytes for: $label", ({ url, body, sig, bodyhash, bodylen }) => {
    pinRandomness();
    const headers = buildAuthHeaders(body, url, CREDS);
    expect(headers.Authorization).toBe(`Bearer COSY.${PINNED_PAYLOAD_B64}.${sig}`);
    expect(headers["Cosy-Bodyhash"]).toBe(bodyhash);
    expect(headers["Cosy-Bodylength"]).toBe(bodylen);
  });

  it("matches the legacy full-string Cosy signature", () => {
    for (const { url, body } of PINNED_VECTORS) {
      pinRandomness();
      const headers = buildAuthHeaders(body, url, CREDS);
      const match = headers.Authorization.match(/^Bearer COSY\.([^.]+)\.([0-9a-f]+)$/);
      expect(match).toBeTruthy();
      const payloadB64 = match?.[1] ?? "";
      const sig = match?.[2] ?? "";

      // The deleted implementation built this exact string before hashing it,
      // so the recomputation is the byte-order oracle for the chained pass.
      const bodyStr = body === null ? "" : Buffer.isBuffer(body) ? body.toString("utf8") : body;
      const legacyInput = `${payloadB64}\n${headers["Cosy-Key"]}\n${headers["Cosy-Date"]}\n${bodyStr}\n${headers["Cosy-Sigpath"]}`;
      expect(sig).toBe(crypto.createHash("md5").update(legacyInput).digest("hex"));

      const bodyBytes = body === null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body);
      expect(headers["Cosy-Bodyhash"]).toBe(crypto.createHash("md5").update(bodyBytes).digest("hex"));
      expect(headers["Cosy-Bodylength"]).toBe(String(bodyBytes.length));
      vi.restoreAllMocks();
    }
  });

  it("strips the algo prefix from the signed path and keeps other paths intact", () => {
    expect(buildAuthHeaders(null, CHAT_URL, CREDS)["Cosy-Sigpath"]).toBe(
      "/api/v2/service/pro/sse/agent_chat_generation",
    );
    expect(buildAuthHeaders(null, "https://api3.qoder.sh/non/algo/prefix", CREDS)["Cosy-Sigpath"]).toBe(
      "/non/algo/prefix",
    );
  });
});
