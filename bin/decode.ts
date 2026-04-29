#!/usr/bin/env bun
// Usage: bun bin/decode.ts <gzip-base64-string>
// Outputs pretty-printed JSON to stdout.

import { decodeGzipBase64 } from "../src/codec";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: decode <gzip-base64-string>");
  process.exit(1);
}

try {
  const json = decodeGzipBase64(arg);
  process.stdout.write(JSON.stringify(JSON.parse(json), null, 2));
  process.stdout.write("\n");
} catch (e) {
  console.error("decode:", (e as Error).message);
  process.exit(1);
}
