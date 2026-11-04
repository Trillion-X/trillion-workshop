// Encode bytes without spreading a typed-array iterator into boxed arguments.
// One bounded ASCII buffer and one final string; the standard base64 bytes stay unchanged.
const alphabet = new TextEncoder().encode('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/');
const decoder = new TextDecoder();
export function base64Of(bytes) {
  const output = new Uint8Array(Math.ceil(bytes.byteLength / 3) * 4);
  let at = 0, out = 0;
  for (; at + 2 < bytes.byteLength; at += 3) {
    const a = bytes[at], b = bytes[at + 1], c = bytes[at + 2];
    output[out++] = alphabet[a >>> 2];
    output[out++] = alphabet[((a & 3) << 4) | (b >>> 4)];
    output[out++] = alphabet[((b & 15) << 2) | (c >>> 6)];
    output[out++] = alphabet[c & 63];
  }
  if (at < bytes.byteLength) {
    const a = bytes[at], b = at + 1 < bytes.byteLength ? bytes[at + 1] : 0;
    output[out++] = alphabet[a >>> 2];
    output[out++] = alphabet[((a & 3) << 4) | (b >>> 4)];
    output[out++] = at + 1 < bytes.byteLength ? alphabet[(b & 15) << 2] : 61;
    output[out] = 61;
  }
  return decoder.decode(output);
}
