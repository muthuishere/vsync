// Minimal argv parser: positional args + --key=value (or --key) flags.
// Stops parsing at `--` (everything after is positional).
//
// `flags` records the **last** value for each --key (back-compat with every
// existing caller). `lists` records **every** value, so callers that want
// repeatable flags (e.g. `--meta k=v --meta k2=v2`) can read them from there.

export type ParsedArgs = {
  positional: string[];
  flags: Record<string, string>;
  lists: Record<string, string[]>;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
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
      let key: string;
      let value: string;
      if (eq === -1) {
        key = arg.slice(2);
        value = "true";
      } else {
        key = arg.slice(2, eq);
        value = arg.slice(eq + 1);
      }
      flags[key] = value;
      (lists[key] ??= []).push(value);
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags, lists };
}
