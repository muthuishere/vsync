#!/usr/bin/env bun
// Usage: vsync versions <env>
// Stub — implementation pending (v0.3.0 in progress).

export async function main(_argv: string[]): Promise<void> {
  console.error("vsync versions: not yet implemented");
  process.exit(1);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
