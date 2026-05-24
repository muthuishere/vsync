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

import { wantsHelp, printHelp } from "../src/help";
import { DOCS_MD } from "../src/templates/docs.md";

const HELP = `
NAME
  vsync docs — print the embedded onboarding reference to stdout

SYNOPSIS
  vsync docs

DESCRIPTION
  Prints a short Markdown reference (commands, vault layout, backup
  recovery procedure with crypto envelope details, agent rules) to stdout.
  The content is a static string shipped inside the binary
  (src/templates/docs.md.ts), so it's always in sync with the verb set at
  this version — no network call, no separate install.

  Useful for committing into a repo as \`infra/AGENTS.md\` so future
  agents working in the repo can self-onboard without external lookup.
  No flags, no prompts.

FLAGS
  --help, -h               print this help and exit

EXAMPLES
  # Print to terminal
  vsync docs

  # Commit into the repo for agent self-onboarding
  vsync docs > infra/AGENTS.md

  # Pipe into a pager
  vsync docs | less

EXIT CODES
  0    docs printed successfully

SEE ALSO
  vsync init(1)            the command the embedded docs walk you through
  README.md                project-level overview
`;

export async function main(argv: string[]): Promise<void> {
  if (wantsHelp(argv)) printHelp(HELP);
  process.stdout.write(DOCS_MD);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
