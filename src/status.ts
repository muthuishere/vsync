// status.ts — pure aggregation for `vsync status`. No I/O against S3 by
// default (decision **P** in v0.13 spec) — only the local file system,
// keychain, and (when `checkRemote` is true) one HEAD per env against S3.
//
// Renders are downstream; this module just returns a structured report.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { vsyncBaseDir } from "./defaults";
import {
  loadConfigFile,
  type ConfigFile,
} from "./repoconfig";
import { listProfiles, profileExists, type NamedProfile } from "./profiles";
import { getKey } from "./keychain";

export type OrphanState = "no-config" | "no-key" | null;

export type StatusCode =
  | "ok"
  | "orphan-no-config"
  | "orphan-no-key"
  | "dangling-profile"
  | "remote-drift"
  | "remote-unreachable";

export type EnvStatus = {
  env: string;
  /** Name of the profile init bound this env to (cfg.initProfile). */
  profile?: string;
  /** Whether the named profile still exists on this machine. */
  profilePresent?: boolean;
  /** Resolved bucket prefix for this env. */
  prefix?: string;
  /** Local gen counter from the last push (currently always undefined — wired in v0.14). */
  gen?: number;
  /** ISO timestamp of last local push, if recorded. */
  lastPush?: string;
  orphan: OrphanState;
  status: {
    ok: boolean;
    code: StatusCode;
    message: string;
  };
};

export type StatusReport = {
  repo: string;
  envs: EnvStatus[];
  profiles: { name: string; endpoint: string; bucket: string }[];
  /** Free-form one-line notices for the renderer (e.g. keychain enum unsupported). */
  notices: string[];
  /** True when this platform supports listing keychain entries. False on Windows / locked-down Linux. */
  keychainEnumerationSupported: boolean;

  // v0.16 — repo identity resolution metadata.
  /** Which precedence step resolved the repo: "flag" (--repo), "file" (.vsync), or "auto" (parsed origin URL). */
  source: "flag" | "file" | "auto";
  /** Human-readable detail for the source (the flag value, the .vsync path, or the origin URL). */
  sourceDetail: string;
  /** Git toplevel. */
  toplevel: string;
  /** Current working directory at the time of the status invocation. */
  cwd: string;
  /** Origin URL from `git config --get remote.origin.url`, or null if unset. */
  originUrl: string | null;
  /** Worktree info: null when in the main worktree, populated for linked worktrees. */
  worktree: { branch: string | null; mainToplevel: string } | null;
};

export type GatherOptions = {
  checkRemote?: boolean;
  /**
   * Pre-resolved repo identity metadata (from src/repo.ts::resolveRepoWithSource).
   * Optional — unit tests that only exercise envs/profiles/keychain logic can
   * omit it and get a synthetic "test" resolution. bin/status.ts always supplies
   * the real resolution so the prefix block renders correctly.
   */
  resolution?: {
    source: "flag" | "file" | "auto";
    sourceDetail: string;
    toplevel: string;
    cwd: string;
    originUrl: string | null;
    worktree: { branch: string | null; mainToplevel: string } | null;
  };
};

/**
 * Walk `<XDG>/vsync/config/<repo>/` listing every `env_*` config file.
 * Returns the bare env name (suffix-stripped) for each.
 *
 * NOTE: existing repoconfig.ts uses `<XDG>/vsync/<repo>/env_<env>` (no
 * intermediate `config/`), so we mirror that layout here.
 */
async function listEnvFiles(repo: string): Promise<string[]> {
  const dir = path.join(vsyncBaseDir(), repo);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err: any) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return [];
    throw err;
  }
  return entries
    .filter((f) => f.startsWith("env_"))
    .map((f) => f.slice(4))
    .filter((e) => /^[a-z0-9._-]+$/i.test(e))
    .sort();
}

/**
 * Build the StatusReport for a repo. Offline-only at this stage; the
 * `checkRemote` branch is reserved for v0.14 wiring.
 */
export async function gatherStatus(
  repo: string,
  opts: GatherOptions = {},
): Promise<StatusReport> {
  const resolution =
    opts.resolution ??
    ({
      source: "auto",
      sourceDetail: "(test default — no real resolution supplied)",
      toplevel: process.cwd(),
      cwd: process.cwd(),
      originUrl: null,
      worktree: null,
    } as const);
  opts = { ...opts, resolution };
  const envs = await listEnvFiles(repo);
  const profiles = await listProfiles();
  const profileNames = new Set(profiles.map((p) => p.name));

  const envStatuses: EnvStatus[] = [];
  for (const env of envs) {
    let cfg: ConfigFile | null = null;
    let readError: string | null = null;
    try {
      cfg = await loadConfigFile(repo, env);
    } catch (err: any) {
      readError = err?.message ?? String(err);
    }

    if (!cfg) {
      envStatuses.push({
        env,
        orphan: null,
        status: {
          ok: false,
          code: "orphan-no-config",
          message:
            readError ?? `config file missing for ${repo}/${env}`,
        },
      });
      continue;
    }

    const profile = cfg.initProfile;
    const profilePresent =
      profile !== undefined ? profileNames.has(profile) : undefined;
    const prefix = cfg.prefix;

    // Try to find the keychain key.
    let key: string | null = null;
    try {
      key = await getKey(repo, env);
    } catch {
      key = null;
    }

    if (!key) {
      envStatuses.push({
        env,
        profile,
        profilePresent,
        prefix,
        orphan: "no-key",
        status: {
          ok: false,
          code: "orphan-no-key",
          message: `config exists but no keychain key for ${repo}/${env}`,
        },
      });
      continue;
    }

    if (profile !== undefined && !profilePresent) {
      envStatuses.push({
        env,
        profile,
        profilePresent,
        prefix,
        orphan: null,
        status: {
          ok: false,
          code: "dangling-profile",
          message: `cfg.initProfile=${profile} but no such profile in ~/.config/vsync/profiles/`,
        },
      });
      continue;
    }

    envStatuses.push({
      env,
      profile,
      profilePresent,
      prefix,
      orphan: null,
      status: { ok: true, code: "ok", message: "ok" },
    });
  }

  // Sort env list by env name for stable output.
  envStatuses.sort((a, b) =>
    a.env < b.env ? -1 : a.env > b.env ? 1 : 0,
  );

  const notices: string[] = [];
  // Keychain enumeration: Bun.secrets does not yet expose a list/enumerate
  // method. We therefore cannot detect "key without config" orphans at the
  // moment — surface that limitation as a notice so operators know.
  const keychainEnumerationSupported = false;
  notices.push(
    "keychain enumeration not supported by Bun.secrets; orphan 'key-without-config' detection skipped on this run.",
  );

  if (opts.checkRemote) {
    // Reserved for v0.14 wiring. Today we just annotate; we don't fail.
    notices.push("--check-remote: remote drift detection is not wired in this build.");
  }

  // v0.16: rename notice — when the resolved name differs from what the
  // origin URL would auto-parse to, surface that fact informationally.
  if (resolution.source !== "auto" && resolution.originUrl) {
    const { parseRemoteUrl, normalize } = await import("./repo");
    const autoName = normalize(parseRemoteUrl(resolution.originUrl));
    if (autoName && autoName !== repo) {
      notices.push(
        `identity \`${repo}\` is a rename — origin would auto-resolve to \`${autoName}\`.`,
      );
    }
  }

  return {
    repo,
    envs: envStatuses,
    profiles: profiles.map((p: NamedProfile) => ({
      name: p.name,
      endpoint: p.endpoint,
      bucket: p.bucket,
    })),
    notices,
    keychainEnumerationSupported,
    source: resolution.source,
    sourceDetail: resolution.sourceDetail,
    toplevel: resolution.toplevel,
    cwd: resolution.cwd,
    originUrl: resolution.originUrl,
    worktree: resolution.worktree,
  };
}
