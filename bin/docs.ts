#!/usr/bin/env bun
// Usage: vsync docs
//
// Prints a short onboarding reference (commands, vault layout, backup
// recovery procedure, agent rules) to stdout. Pipe wherever you want:
//   vsync docs > infra/AGENTS.md
//
// No flags, no prompts. Content is a static string in src/templates/
// docs.md.ts so it ships with the binary and stays in sync with the
// verb set.

import { DOCS_MD } from "../src/templates/docs.md";

export async function main(_argv: string[]): Promise<void> {
  process.stdout.write(DOCS_MD);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
