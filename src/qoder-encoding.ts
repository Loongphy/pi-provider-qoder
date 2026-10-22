const qoderCustomAlphabet = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const qoderStdAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Byte-for-byte translation table for the alphabet swap, indexed by the ASCII
 * code of a base64 character. Characters outside the base64 alphabet map to
 * themselves, which reproduces the reference implementation's fall-through
 * branch; `=` maps to `$`.
 *
 * Built once at module load so encoding is a table lookup instead of a
 * per-character `qoderStdAlphabet.indexOf(c)` — a linear scan over 64
 * characters for every character of the payload.
 */
const QODER_SWAP_TABLE = new Uint8Array(256);
for (let code = 0; code < 256; code++) {
  QODER_SWAP_TABLE[code] = code;
}
for (let i = 0; i < qoderStdAlphabet.length; i++) {
  QODER_SWAP_TABLE[qoderStdAlphabet.charCodeAt(i)] = qoderCustomAlphabet.charCodeAt(i);
}
QODER_SWAP_TABLE["=".charCodeAt(0)] = "$".charCodeAt(0);

/**
 * Qoder's request-body obfuscation: base64, rotate three segments
 * (tail | middle | head), then swap the base64 alphabet for a custom one.
 *
 * The output is written straight into one preallocated buffer and the three
 * segments are read in place, so a request never materializes the rotated
 * copy or a result string. That matters at agent scale: the reference form
 * spent ~400ms of BLOCKING main-thread time on a 5MB body (measured: 90-120ms
 * per MB, dominated by `out += char` and the per-character alphabet scan), and
 * it runs on the UI thread once per turn — every tool call of an agent loop —
 * which is what users feel as a stuttering TUI. Byte-identical to the
 * reference (asserted by tests) and ~6-16x faster.
 *
 * Returns ASCII bytes as a Buffer rather than a string: the callers sign and
 * send the result as bytes, so a string return forced a full-body re-copy on
 * every request just to get the bytes back. The return type is spelled
 * `Buffer<ArrayBuffer>` because a bare `Buffer` widens to
 * `Buffer<ArrayBufferLike>`, which `fetch`'s `BodyInit` rejects.
 */
export function qoderEncodeBody(plaintext: string | Buffer): Buffer<ArrayBuffer> {
  const std = Buffer.isBuffer(plaintext) ? plaintext.toString("base64") : Buffer.from(plaintext).toString("base64");
  const n = std.length;
  const a = Math.floor(n / 3);
  const out = Buffer.allocUnsafe(n);

  // std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a), mapped in place.
  let o = 0;
  for (let i = n - a; i < n; i++) out[o++] = QODER_SWAP_TABLE[std.charCodeAt(i)];
  for (let i = a; i < n - a; i++) out[o++] = QODER_SWAP_TABLE[std.charCodeAt(i)];
  for (let i = 0; i < a; i++) out[o++] = QODER_SWAP_TABLE[std.charCodeAt(i)];

  return out;
}
