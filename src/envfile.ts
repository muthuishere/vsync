// Parse a `.env.<ENV>` file into push-ready secret tasks.
//
// Zero-policy parser (v0.7): the parser carries no defaults. Every rule that
// affects what gets pushed is supplied by the caller via `ParseOptions`.
//
// Behavior overview:
//   - skip blank lines + `#` comments
//   - first `=` splits key/value, both trimmed
//   - strip a single pair of surrounding `"` or `'` from the value
//   - keys listed in `opts.excludeProperties` are dropped onto `skipped` and
//     never pushed; passing `[]` means nothing is skipped.
//   - keys ending in one of `opts.inlineFileSuffixes` (and strictly longer
//     than the suffix) are treated as file references — the suffix is
//     stripped and the file's bytes are pushed under the stripped key.
//     Passing `[]` disables file inlining entirely.
//   - placeholder expansion in every value: `${VAULT_ROOT}`, `${HOME}`,
//     leading `~/`. `VAULT_ROOT` = the directory the env file lives in.
//     Disable with `opts.expandPlaceholders === false`.
//
// File-reference convention (when a suffix is configured, e.g. `_PATH`):
//
//   FOO_PATH=keys/foo            -> push as FOO with contents of <vault>/keys/foo
//   FOO_FILE=./keys/foo          -> push as FOO with contents of <vault>/keys/foo
//
// Relative paths are always resolved against `VAULT_ROOT` (i.e. the env
// file's own directory). Absolute paths and `~/` are honored as-is.
//
// All-or-none: if any file referenced by an inline-file-suffix key is missing
// or unreadable, parseEnvFile throws a single aggregated error and emits no
// tasks. Sync must not run partially.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export type SecretTask = { key: string; value: string };

export type ParseOptions = {
  /** Suffixes that turn a key into a file reference. Empty = no inlining. */
  inlineFileSuffixes: string[];

  /** Keys to skip entirely (never pushed). Empty = nothing skipped. */
  excludeProperties: string[];

  /** Placeholder expansion in values. Default true. */
  expandPlaceholders?: boolean;
};

export type ParsedEnv = {
  tasks: SecretTask[];
  skipped: Array<{ key: string; reason: "excluded" }>;
};

export function parseEnvFile(path: string, opts: ParseOptions): ParsedEnv {
  if (!existsSync(path)) {
    throw new Error(`.env file not found: ${path}`);
  }
  const raw = readFileSync(path, "utf8");
  const vaultRoot = dirname(path);
  const tasks: SecretTask[] = [];
  const skipped: ParsedEnv["skipped"] = [];
  const errors: string[] = [];

  const excludeSet = new Set(opts.excludeProperties);
  const expand = opts.expandPlaceholders !== false;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    const rawValue = stripQuotes(line.slice(eq + 1).trim());

    if (excludeSet.has(key)) {
      skipped.push({ key, reason: "excluded" });
      continue;
    }

    const value = expand ? expandPlaceholders(rawValue, vaultRoot) : rawValue;

    // Generic suffix rule: caller-supplied suffixes → strip + inline file.
    const stripped = stripFileSuffix(key, opts.inlineFileSuffixes);
    if (stripped) {
      readFileRef(value, vaultRoot, key, errors, (content) => {
        tasks.push({ key: stripped, value: content });
      });
      continue;
    }

    // Plain value.
    tasks.push({ key, value });
  }

  if (errors.length > 0) {
    throw new Error(
      `parseEnvFile: aborting sync — ${errors.length} file reference(s) could not be resolved:\n  - ${errors.join("\n  - ")}`,
    );
  }

  return { tasks, skipped };
}

function stripQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

function expandPlaceholders(value: string, vaultRoot: string): string {
  let out = value;
  if (out.startsWith("~/")) out = join(homedir(), out.slice(2));
  out = out.replaceAll("${VAULT_ROOT}", vaultRoot);
  out = out.replaceAll("${HOME}", homedir());
  return out;
}

function stripFileSuffix(key: string, suffixes: string[]): string | null {
  for (const suf of suffixes) {
    if (!suf) continue;
    if (key.endsWith(suf) && key.length > suf.length) {
      return key.slice(0, -suf.length);
    }
  }
  return null;
}

function readFileRef(
  value: string,
  vaultRoot: string,
  key: string,
  errors: string[],
  onSuccess: (content: string) => void,
): void {
  const resolved = isAbsolute(value) ? value : join(vaultRoot, value);
  if (!existsSync(resolved)) {
    errors.push(`${key}: file not found at ${resolved}`);
    return;
  }
  try {
    onSuccess(readFileSync(resolved, "utf8"));
  } catch (e) {
    errors.push(`${key}: error reading ${resolved}: ${(e as Error).message}`);
  }
}
