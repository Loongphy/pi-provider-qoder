import { describe, expect, it } from "vitest";
import { qoderEncodeBody } from "../qoder-encoding.js";

describe("qoderEncodeBody", () => {
  it("encodes a simple string", () => {
    const result = qoderEncodeBody("hello");
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
    // Should not contain standard base64 padding char '='
    expect(result).not.toContain("=");
  });

  it("encodes a Buffer", () => {
    const buf = Buffer.from("hello world");
    const result = qoderEncodeBody(buf);
    expect(result).toBeTruthy();
    expect(result).not.toContain("=");
  });

  it("produces deterministic output", () => {
    const a = qoderEncodeBody("test input");
    const b = qoderEncodeBody("test input");
    expect(a).toBe(b);
  });

  it("produces different output for different inputs", () => {
    const a = qoderEncodeBody("input A");
    const b = qoderEncodeBody("input B");
    expect(a).not.toBe(b);
  });

  it("handles empty string", () => {
    const result = qoderEncodeBody("");
    expect(result).toBe("");
  });

  it("handles empty Buffer", () => {
    const result = qoderEncodeBody(Buffer.alloc(0));
    expect(result).toBe("");
  });

  it("replaces '=' padding with '$'", () => {
    // Base64 of "a" is "YQ==" which has padding — our encoding should use $
    const result = qoderEncodeBody("a");
    expect(result).not.toContain("=");
    expect(result).toContain("$");
  });

  it("uses custom alphabet (not standard base64)", () => {
    const result = qoderEncodeBody("The quick brown fox");
    // Standard base64 would use A-Za-z0-9+/=
    // Our encoding uses a custom alphabet, so the output should differ
    const stdBase64 = Buffer.from("The quick brown fox").toString("base64");
    expect(result).not.toBe(stdBase64);
  });

  it("handles binary content", () => {
    const binary = Buffer.from([0x00, 0xff, 0x80, 0x7f, 0x01]);
    const result = qoderEncodeBody(binary);
    expect(result).toBeTruthy();
    expect(result).not.toContain("=");
  });

  it("handles JSON content", () => {
    const json = JSON.stringify({ key: "value", num: 42 });
    const result = qoderEncodeBody(json);
    expect(result).toBeTruthy();
    expect(result).not.toContain("=");
  });
});

describe("qoderEncodeBody equivalence with the reference implementation", () => {
  /**
   * The naive transcription of Qoder's obfuscation, kept here on purpose: the
   * production version is optimized (table lookup into a preallocated buffer),
   * and this is the only thing standing between a refactor and silently
   * changing the wire bytes the upstream rejects.
   */
  function referenceEncode(plaintext: string | Buffer): string {
    const customAlphabet = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
    const stdAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const std = Buffer.isBuffer(plaintext) ? plaintext.toString("base64") : Buffer.from(plaintext).toString("base64");
    const n = std.length;
    const a = Math.floor(n / 3);
    const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
    let out = "";
    for (let i = 0; i < n; i++) {
      const c = rearranged[i];
      if (c === "=") out += "$";
      else {
        const idx = stdAlphabet.indexOf(c);
        out += idx >= 0 ? customAlphabet[idx] : c;
      }
    }
    return out;
  }

  it("matches byte-for-byte across input lengths and alphabets", () => {
    const cases: (string | Buffer)[] = [
      "",
      "a",
      "ab",
      "abc",
      "abcd",
      "abcde",
      "hello world",
      JSON.stringify({ k: "v", n: 1, arr: [1, 2, 3] }),
      "中文与 emoji 🚀 mixed",
      Buffer.from([0x00, 0x01, 0xfe, 0xff]),
    ];
    // Every base64 length residue class, plus long enough to rotate segments.
    for (let len = 0; len <= 200; len++) {
      cases.push(Buffer.alloc(len, 0x5a).toString("base64"));
      cases.push("x".repeat(len));
    }
    // A pseudo-random byte sweep, all three padding classes. Math.imul keeps
    // the LCG inside int32 so the sequence is deterministic (a plain multiply
    // overflows Number.MAX_SAFE_INTEGER and loses precision).
    let seed = 12345;
    const rand = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) | 0;
      return (seed >>> 8) & 0xff;
    };
    for (let len = 0; len < 64; len++) {
      cases.push(Buffer.from(Array.from({ length: len }, rand)));
    }

    for (const c of cases) {
      expect(qoderEncodeBody(c), `input: ${String(c).slice(0, 24)}`).toBe(referenceEncode(c));
    }
  });

  it("pins the wire format with a golden vector", () => {
    expect(qoderEncodeBody("hello")).toBe("q$FruHPH");
  });
});
