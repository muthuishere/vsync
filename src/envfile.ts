// Parse a `.env.<ENV>` file into push-ready secret tasks.
//
// Behavior overview:
//   - skip blank lines + `#` comments
//   - first `=` splits key/value, both trimmed
//   - strip a single pair of surrounding `"` or `'` from the value
//   - skip GITHUB_TOKEN / GOOGLE_APPLICATION_CREDENTIALS (local-only)
//   - placeholder expansion in every value: `${VAULT_ROOT}`, `${HOME}`,
//     leading `~/`. `VAULT_ROOT` = the directory the env file lives in.
//
// File-reference convention (vsync reads the file, pushes its contents
// under the stripped key name):
//
//   FOO_PATH=keys/foo            -> push as FOO with contents of <vault>/keys/foo
//   FOO_FILE=./keys/foo          -> push as FOO with contents of <vault>/keys/foo
//
// Relative paths are always resolved against `VAULT_ROOT` (i.e. the env
// file's own directory). Absolute paths and `~/` are honored as-is.
//
// All-or-none: if any file referenced by a `*_PATH`/`*_FILE` key is missing
// or unreadable, parseEnvFile throws a single aggregated error and emits no
// tasks. Sync must not run partially.
//
// GITHUB_REPO and GCP_PROJECT_ID are pulled out into `meta` and never pushed
// as secrets — they're routing config consumed by sync-secrets itself.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export type SecretTask = { key: string; value: string };

export type ParsedEnv = {
  tasks: SecretTask[];
  meta: { GITHUB_REPO?: string; GCP_PROJECT_ID?: string };
};

const LOCAL_ONLY = new Set(["GITHUB_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS"]);
const ROUTING = new Set(["GITHUB_REPO", "GCP_PROJECT_ID"]);

const PATH_SUFFIXES = ["_PATH", "_FILE"] as const;

export function parseEnvFile(path: string): ParsedEnv {
  if (!existsSync(path)) {
    throw new Error(`.env file not found: ${path}`);
  }
  const raw = readFileSync(path, "utf8");
  const vaultRoot = dirname(path);
  const tasks: SecretTask[] = [];
  const meta: ParsedEnv["meta"] = {};
  const errors: string[] = [];

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    const rawValue = stripQuotes(line.slice(eq + 1).trim());

    if (LOCAL_ONLY.has(key)) {
      console.log(`Skipping ${key} (local use only)`);
      continue;
    }

    const value = expandPlaceholders(rawValue, vaultRoot);

    if (ROUTING.has(key)) {
      meta[key as keyof ParsedEnv["meta"]] = value;
      continue;
    }

    // Generic suffix rule: *_PATH or *_FILE → strip suffix, push file body.
    const stripped = stripPathSuffix(key);
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

  return { tasks, meta };
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

function stripPathSuffix(key: string): string | null {
  for (const suf of PATH_SUFFIXES) {
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
