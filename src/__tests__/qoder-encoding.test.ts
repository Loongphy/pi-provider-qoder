import { describe, expect, it } from "vitest";
import { qoderEncodeBody } from "../qoder-encoding.js";

/** The wire bytes as text, so the assertions below stay readable. */
function enc(input: string | Buffer): string {
  return qoderEncodeBody(input).toString("latin1");
}

describe("qoderEncodeBody", () => {
  it("returns the ASCII payload as a Buffer", () => {
    const result = qoderEncodeBody("hello");
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    // Should not contain standard base64 padding char '='
    expect(enc("hello")).not.toContain("=");
  });

  it("encodes a Buffer", () => {
    const buf = Buffer.from("hello world");
    expect(enc(buf)).not.toContain("=");
  });

  it("produces deterministic output", () => {
    expect(qoderEncodeBody("test input")).toStrictEqual(qoderEncodeBody("test input"));
  });

  it("produces different output for different inputs", () => {
    expect(enc("input A")).not.toBe(enc("input B"));
  });

  it("handles empty string", () => {
    expect(qoderEncodeBody("")).toStrictEqual(Buffer.alloc(0));
  });

  it("handles empty Buffer", () => {
    expect(qoderEncodeBody(Buffer.alloc(0))).toStrictEqual(Buffer.alloc(0));
  });

  it("replaces '=' padding with '$'", () => {
    // Base64 of "a" is "YQ==" which has padding — our encoding should use $
    const result = enc("a");
    expect(result).not.toContain("=");
    expect(result).toContain("$");
  });

  it("uses custom alphabet (not standard base64)", () => {
    // Standard base64 would use A-Za-z0-9+/=; our encoding uses a custom
    // alphabet, so the output must differ.
    const stdBase64 = Buffer.from("The quick brown fox").toString("base64");
    expect(enc("The quick brown fox")).not.toBe(stdBase64);
  });

  it("handles binary content", () => {
    const binary = Buffer.from([0x00, 0xff, 0x80, 0x7f, 0x01]);
    const result = enc(binary);
    expect(result).not.toContain("=");
  });

  it("handles JSON content", () => {
    const json = JSON.stringify({ key: "value", num: 42 });
    expect(enc(json)).not.toContain("=");
  });

  it("is safe to send: pure ASCII, no bytes above 0x7f", () => {
    // The Buffer is signed and POSTed as-is, so the table must never emit a
    // non-ASCII byte (which allocUnsafe would happily leave as garbage).
    for (const input of ["hello", "a", Buffer.from([0x00, 0xff, 0x10]).toString(), JSON.stringify({ a: 1 })]) {
      for (const byte of qoderEncodeBody(input)) {
        expect(byte).toBeLessThanOrEqual(0x7f);
      }
    }
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
      expect(enc(c), `input: ${String(c).slice(0, 24)}`).toBe(referenceEncode(c));
    }
  });

  it("pins the wire format with a golden vector", () => {
    expect(enc("hello")).toBe("q$FruHPH");
  });
});
