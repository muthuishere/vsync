// Minimal argv parser: positional args + --key=value (or --key) flags.
// Stops parsing at `--` (everything after is positional).

export type ParsedArgs = {
  positional: string[];
  flags: Record<string, string>;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  let passthrough = false;
  for (const arg of argv) {
    if (passthrough) {
      positional.push(arg);
      continue;
    }
    if (arg === "--") {
      passthrough = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq === -1) {
        flags[arg.slice(2)] = "true";
      } else {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}
