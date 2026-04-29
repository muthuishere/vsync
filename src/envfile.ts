// Parse a `.env.<ENV>` file into push-ready secret tasks.
//
// Mirrors the parsing behavior of reqsume/secrets.go:
//   - skip blank lines + `#` comments
//   - first `=` splits key/value, both trimmed
//   - strip a single pair of surrounding `"` or `'` from the value
//   - skip GITHUB_TOKEN / GOOGLE_APPLICATION_CREDENTIALS (local-only)
//   - GCP_SA_KEY_FILE_PATH=<path>  → reads file, pushes as GCP_SA_KEY (must look like JSON)
//   - SSH_KEY_PATH=<path>          → reads file, pushes as SSH_PRIVATE_KEY
//
// GITHUB_REPO and GCP_PROJECT_ID are pulled out into `meta` and never pushed
// as secrets — they're routing config consumed by sync-secrets itself.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SecretTask = { key: string; value: string };

export type ParsedEnv = {
  tasks: SecretTask[];
  meta: { GITHUB_REPO?: string; GCP_PROJECT_ID?: string };
};

const LOCAL_ONLY = new Set(["GITHUB_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS"]);
const ROUTING = new Set(["GITHUB_REPO", "GCP_PROJECT_ID"]);

export function parseEnvFile(path: string): ParsedEnv {
  if (!existsSync(path)) {
    throw new Error(`.env file not found: ${path}`);
  }
  const raw = readFileSync(path, "utf8");
  const tasks: SecretTask[] = [];
  const meta: ParsedEnv["meta"] = {};

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = stripQuotes(line.slice(eq + 1).trim());

    if (LOCAL_ONLY.has(key)) {
      console.log(`Skipping ${key} (local use only)`);
      continue;
    }

    if (ROUTING.has(key)) {
      meta[key as keyof ParsedEnv["meta"]] = value;
      continue;
    }

    if (key === "GCP_SA_KEY_FILE_PATH") {
      const content = readFileExpandTilde(value).trim();
      if (!content.startsWith("{")) {
        throw new Error(`GCP key file does not look like JSON: ${value}`);
      }
      tasks.push({ key: "GCP_SA_KEY", value: content });
      continue;
    }

    if (key === "SSH_KEY_PATH") {
      try {
        tasks.push({ key: "SSH_PRIVATE_KEY", value: readFileExpandTilde(value) });
      } catch (e) {
        console.warn(
          `Warning: error reading SSH private key from ${value}: ${(e as Error).message}`,
        );
      }
      continue;
    }

    tasks.push({ key, value });
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

function readFileExpandTilde(path: string): string {
  if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  return readFileSync(path, "utf8");
}
