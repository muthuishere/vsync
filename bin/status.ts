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
import { getRepoName } from "../src/repo";
import { gatherStatus, type StatusReport } from "../src/status";

/** Render the human-readable tabular output as a single string. */
export function renderStatusText(report: StatusReport): string {
  const lines: string[] = [];
  lines.push(`Repo: ${report.repo}`);
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

export async function main(argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv);
  const wantJson = flags.json === "true";
  const wantQuiet = flags.quiet === "true";
  const wantCheckRemote = flags["check-remote"] === "true";

  if (wantJson && wantQuiet) {
    console.error("error: --json and --quiet are mutually exclusive.");
    process.exit(1);
  }

  const repo = await getRepoName({ override: flags.repo });
  const report = await gatherStatus(repo, { checkRemote: wantCheckRemote });

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
