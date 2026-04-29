// JSON ⇄ gzip+base64 codec.
// Pure functions, easily unit-testable. CLIs in bin/ are thin wrappers.

export function encodeGzipBase64(json: string): string {
  // Validate input is JSON before bothering to compress.
  JSON.parse(json);
  const gz = Bun.gzipSync(new TextEncoder().encode(json));
  return Buffer.from(gz).toString("base64");
}

export function decodeGzipBase64(b64: string): string {
  const gz = Buffer.from(b64.trim(), "base64");
  if (gz.byteLength === 0) {
    throw new Error("decoded base64 is empty");
  }
  const raw = Bun.gunzipSync(gz);
  const json = new TextDecoder().decode(raw);
  // Validate output is JSON before returning.
  JSON.parse(json);
  return json;
}
