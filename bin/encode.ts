#!/usr/bin/env bun
// Usage: bun bin/encode.ts <json-string>
// Outputs the gzip+base64-encoded form to stdout.

import { encodeGzipBase64 } from "../src/codec";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: encode <json-string>");
  process.exit(1);
}

try {
  process.stdout.write(encodeGzipBase64(arg));
  process.stdout.write("\n");
} catch (e) {
  console.error("encode:", (e as Error).message);
  process.exit(1);
}
