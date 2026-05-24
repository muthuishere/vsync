// Shared --help / -h handling for every subcommand.
//
// `parseArgs` doesn't model short flags (`-h`), so subcommands inspect argv
// up-front with `wantsHelp`. When true they call `printHelp` and exit 0,
// before any validation, env-var, or TTY-dependent code runs.

export function wantsHelp(argv: string[]): boolean {
  for (const a of argv) {
    if (a === "--") return false; // explicit end-of-options
    if (a === "--help" || a === "-h") return true;
  }
  return false;
}

/** Print a HELP block to stdout (stripped of a single leading newline) and exit 0. */
export function printHelp(block: string): never {
  const text = block.startsWith("\n") ? block.slice(1) : block;
  process.stdout.write(text);
  if (!text.endsWith("\n")) process.stdout.write("\n");
  process.exit(0);
}
