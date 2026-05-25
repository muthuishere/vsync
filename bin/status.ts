#!/usr/bin/env bun
// vsync status — what's wired up on this machine, and is any of it broken.
//
// Usage:
//   vsync status [--check-remote] [--json] [--quiet] [--repo=<name>]
//
// Offline-first by default. Reads:
//   - <XDG>/vsync/<repo>/env_* (per-(repo, env) configs)
//   - <XDG>/vsync/profiles/*.json
//   - OS keychain (for orphan-no-key detection)
//
// `--check-remote` is reserved for a later wiring (v0.14).
// See docs/specs/v0.13-profiles-init-status.md §4.

import { parseArgs } from "../src/argv";
import { wantsHelp, printHelp } from "../src/help";
import { resolveRepoWithSource } from "../src/repo";
import { gatherStatus, type StatusReport } from "../src/status";

const HELP = `
NAME
  vsync status — summarise local configs, profiles, and orphans

SYNOPSIS
  vsync status [--json] [--quiet] [--check-remote] [--repo=<name>]

DESCRIPTION
  Offline-first health check for this machine. Reads (no network):

    - <XDG>/vsync/<repo>/env_* — per-(repo, env) config files
    - <XDG>/vsync/profiles/*.json — named credential profiles
    - the OS keychain — for orphan-no-key detection

  Output is a per-env table (env / profile / prefix / gen / last push /
  status) followed by the list of profiles and any notices (e.g. removed
  profile, missing keychain key, orphan files). Useful before \`vsync push\`
  to confirm the (repo, env) is fully wired up.

  --json emits a machine-readable report (same data, JSON shape).
  --quiet exits non-zero and prints failing rows to stderr only — for CI.
  --check-remote is reserved for a future release; currently a no-op.

  See docs/specs/v0.13-profiles-init-status.md §4.

FLAGS
  --json                   print a machine-readable JSON report
  --quiet                  print only failing-row summary on stderr; exit
                           1 if anything is broken (CI mode)
  --check-remote           (reserved) probe S3 + audit log; not wired yet
  --repo=<name>            override the auto-detected repo name
  --help, -h               print this help and exit

EXAMPLES
  # Human-readable table
  vsync status

  # CI guard — exit non-zero if anything is broken
  vsync status --quiet

  # Pipe into jq for selective checks
  vsync status --json | jq '.envs[] | select(.status.ok == false)'

EXIT CODES
  0    every env is OK (or only informational notices)
  1    --json and --quiet combined; or --quiet and at least one env broken

SEE ALSO
  vsync init(1)            populate the configs this command summarises
  vsync profile list(1)    inspect the profiles referenced here
  docs/specs/v0.13-profiles-init-status.md
`;

/** Render the human-readable tabular output as a single string. */
export function renderStatusText(report: StatusReport): string {
  const lines: string[] = [];
  // v0.16 prefix block — repo identity, source, toplevel, cwd, origin.
  const sourceLabel = sourceDisplay(report.source, report.sourceDetail);
  lines.push(`Repo:     ${report.repo}`);
  lines.push(`Source:   ${sourceLabel}`);
  lines.push(`Toplevel: ${report.toplevel}`);
  if (report.cwd !== report.toplevel) {
    lines.push(`CWD:      ${report.cwd}`);
  }
  lines.push(`Origin:   ${report.originUrl ?? "(not set)"}`);
  if (report.worktree) {
    const branchHint = report.worktree.branch
      ? `${report.worktree.branch} `
      : "";
    lines.push(
      `Worktree: ${branchHint}(linked from ${report.worktree.mainToplevel})`,
    );
  }
  lines.push("");

  if (report.envs.length === 0) {
    lines.push("no envs configured on this machine for this repo.");
    lines.push(
      "Run `vsync init <env> --profile=<name>` after `vsync profile add <name>`.",
    );
  } else {
    const rows = report.envs.map((e) => {
      const profileCell =
        e.profile === undefined
          ? "—"
          : e.profilePresent === false
            ? `${e.profile} (REMOVED)`
            : e.profile;
      const prefixCell = e.prefix ?? "—";
      const genCell = e.gen !== undefined ? String(e.gen) : "—";
      const lastPushCell = e.lastPush ?? "—";
      const statusCell = e.status.ok ? "ok" : `✘ ${e.status.message}`;
      return {
        env: e.env,
        profile: profileCell,
        prefix: prefixCell,
        gen: genCell,
        lastPush: lastPushCell,
        status: statusCell,
      };
    });
    const widths = {
      env: Math.max(3, ...rows.map((r) => r.env.length)),
      profile: Math.max(7, ...rows.map((r) => r.profile.length)),
      prefix: Math.max(6, ...rows.map((r) => r.prefix.length)),
      gen: Math.max(3, ...rows.map((r) => r.gen.length)),
      lastPush: Math.max(9, ...rows.map((r) => r.lastPush.length)),
    };
    const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
    lines.push(
      `${pad("env", widths.env)}  ${pad("profile", widths.profile)}  ${pad("prefix", widths.prefix)}  ${pad("gen", widths.gen)}  ${pad("last push", widths.lastPush)}  status`,
    );
    for (const r of rows) {
      lines.push(
        `${pad(r.env, widths.env)}  ${pad(r.profile, widths.profile)}  ${pad(r.prefix, widths.prefix)}  ${pad(r.gen, widths.gen)}  ${pad(r.lastPush, widths.lastPush)}  ${r.status}`,
      );
    }
  }

  lines.push("");
  const pCount = report.profiles.length;
  if (pCount === 0) {
    lines.push("Profiles on this machine: (none)");
    lines.push("  Run `vsync profile add <name>` to create one.");
  } else {
    lines.push(`Profiles on this machine (${pCount}):`);
    const widths = {
      name: Math.max(4, ...report.profiles.map((p) => p.name.length)),
    };
    const pad = (s: string, w: number) =>
      s + " ".repeat(Math.max(0, w - s.length));
    for (const p of report.profiles) {
      const ep = p.endpoint.replace(/^https?:\/\//, "");
      lines.push(`  ${pad(p.name, widths.name)}  ${ep}`);
    }
  }

  if (report.notices.length > 0) {
    lines.push("");
    lines.push("Notices:");
    for (const n of report.notices) {
      lines.push(`  - ${n}`);
    }
  }

  return lines.join("\n");
}

/** Render the report as a JSON string (machine-readable). */
export function renderStatusJson(report: StatusReport): string {
  const payload = {
    repo: report.repo,
    source: report.source,
    sourceDetail: report.sourceDetail,
    toplevel: report.toplevel,
    cwd: report.cwd,
    originUrl: report.originUrl,
    worktree: report.worktree,
    envs: report.envs.map((e) => ({
      env: e.env,
      profile: e.profile ?? null,
      profilePresent: e.profilePresent ?? null,
      prefix: e.prefix ?? null,
      gen: e.gen ?? null,
      lastPush: e.lastPush ?? null,
      status: {
        ok: e.status.ok,
        code: e.status.code,
        message: e.status.message,
      },
    })),
    profiles: report.profiles,
    notices: report.notices,
    keychainEnumerationSupported: report.keychainEnumerationSupported,
  };
  return JSON.stringify(payload, null, 2);
}

function sourceDisplay(
  source: "flag" | "file" | "auto",
  detail: string,
): string {
  switch (source) {
    case "flag":
      return `flag (${detail})`;
    case "file":
      return `file (${detail})`;
    case "auto":
      return `auto (${detail})`;
  }
}

export async function main(argv: string[]): Promise<void> {
  if (wantsHelp(argv)) printHelp(HELP);
  const { flags } = parseArgs(argv);
  const wantJson = flags.json === "true";
  const wantQuiet = flags.quiet === "true";
  const wantCheckRemote = flags["check-remote"] === "true";

  if (wantJson && wantQuiet) {
    console.error("error: --json and --quiet are mutually exclusive.");
    process.exit(1);
  }

  const resolution = await resolveRepoWithSource({ override: flags.repo });
  const report = await gatherStatus(resolution.repo, {
    checkRemote: wantCheckRemote,
    resolution: {
      source: resolution.source,
      sourceDetail: resolution.sourceDetail,
      toplevel: resolution.toplevel,
      cwd: resolution.cwd,
      originUrl: resolution.originUrl,
      worktree: resolution.worktree,
    },
  });

  if (wantJson) {
    console.log(renderStatusJson(report));
    return;
  }

  const allOk = report.envs.every((e) => e.status.ok);

  if (wantQuiet) {
    if (allOk) {
      // exit 0 implicitly — no output
      return;
    }
    // surface the failing summary to stderr so CI logs show why
    for (const e of report.envs) {
      if (!e.status.ok) {
        console.error(`${e.env}: ${e.status.code} — ${e.status.message}`);
      }
    }
    process.exit(1);
  }

  console.log(renderStatusText(report));
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
