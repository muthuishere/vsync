# `vsync` v0.4.0 — Spec

**Status:** design · target package `@muthuishere/vsync` · additive over 0.3.x (no wire-format break)

One theme: an **audit log** at `s3://<bucket>/<repo>/<env>/audit.csv`. Every `pull`, `push`, `import`, and `export` appends one row. On by default. Best-effort — an audit-write failure never fails the parent command.

That's the whole feature. Access removal, per-user IAM, cryptographic recipient lists, key rotation as a verb — all deferred (§9). Audit is the smallest useful step toward visibility; everything else is layered on top once we know what people actually do with the log.

For prior context, see `SPEC.md` (v0.2) and `SPEC-v0.3.md`.

---

## 1. Diff from 0.3.x

| | 0.3.x | 0.4.0 |
|---|---|---|
| Audit | None | `audit.csv` at the env's S3 prefix, appended on every state-changing op |
| Verbs | 8 | **9** — adds `audit` |
| Config schema | `version: 1` | `version: 1` (compatible — new optional `audit` block) |
| Bundle wire format | `RQE1` + `RQEM0001` | unchanged |
| Share file format | `SLS1` + ExportPayload v2 | unchanged |

No client written against 0.3.x breaks. No reformat of S3 objects. No keychain migration. Old clients ignore `audit.csv`; new clients tolerate its absence (first writer creates it with the header row).

---

## 2. What the audit log is — and is not

| | |
|---|---|
| **Is** | A transparency aid. A CSV every teammate appends to so the team can see who pulled/pushed/exported from where, and when. |
| **Is not** | Tamper-evident. A bad actor with bucket write can rewrite the CSV. Tamper-evidence needs signed/chained entries and a per-user signing key — out of scope. |
| **Is not** | A gate. If S3 is unreachable or the bucket rejects the write, the parent command (pull/push/etc.) still succeeds. A warning prints to stderr. |
| **Is not** | A way to claw back already-pulled secrets. Once a teammate has pulled, they have a local copy of everything — that's the model. |

---

## 3. Storage

```
s3://<bucket>/<repo>/<env>/audit.csv
```

Single object, append-only by convention (vsync never issues `DeleteObject` on it). First writer creates it with the header row. Readers tolerate absence (`(no audit log yet)`).

---

## 4. Wire format

UTF-8 CSV with header. RFC 4180 quoting (any field containing `,`, `"`, or newline is double-quoted; embedded `"` is doubled). Writers always emit a trailing newline.

**Columns (locked):**

```
ts,action,version_ts,hostname,local_ip,os_user,git_email,vsync_version,bun_version,meta
```

| Column | Source | Empty if |
|---|---|---|
| `ts` | `new Date().toISOString()` | never |
| `action` | one of `pull`, `push`, `import`, `export` | never |
| `version_ts` | the bundle TS the action read or wrote | action is `import`/`export` |
| `hostname` | `os.hostname()` | hostname unreadable |
| `local_ip` | first non-loopback IPv4 from `os.networkInterfaces()`; else first IPv6; else empty | no usable iface |
| `os_user` | `process.env.USER ?? process.env.USERNAME` | unset |
| `git_email` | `git config --get user.email` (cwd) | not a git repo / unset |
| `vsync_version` | `package.json::version` | never |
| `bun_version` | `process.versions.bun` | never |
| `meta` | **user-supplied** JSON object — see below | no `--note`/`--meta`/env var supplied (cell is empty, not `{}`) |

No public IP — slow, privacy-touchy, easy to add later.

Adding a column in a future minor is allowed as long as it goes to the right of the existing ones; readers parse by header, not position.

### 4.1 The `meta` column

`meta` is a single JSON object — the user's expandable escape hatch. Vsync neither interprets keys nor enforces a schema; it just serializes and stores. Examples:

```json
{"note":"hotfix prod outage"}
{"note":"ci","ticket":"FOO-123","branch":"hotfix/db-timeout"}
{"run_id":"7891234","commit":"abc123","actor":"deploy-bot"}
```

In the CSV cell, the JSON is RFC 4180 quoted (embedded `"` doubled, whole field wrapped in `"`). Spreadsheet tools handle this; the `vsync audit` pretty-printer unwraps it and surfaces `meta.note` as its own column.

**Four input paths**, merged in this priority order (last wins):

| Source | Becomes |
|---|---|
| `$VSYNC_AUDIT_META=<json>` env var | base object (parsed as JSON; invalid JSON → warning, ignored) |
| `$VSYNC_AUDIT_NOTE=<text>` env var | merges `{ note: <text> }` |
| `--meta key=value` flag (repeatable) | merges each as a string-valued key |
| `--note=<text>` flag | merges `{ note: <text> }` |

So `--note` is sugar — internally it's just `--meta note=<text>`. The user-friendly flag and the expandable flag write to the same place.

**CI ergonomics:**

```bash
VSYNC_AUDIT_META='{"run_id":"7891234","commit":"abc123"}' \
VSYNC_AUDIT_NOTE="prod deploy" \
vsync pull production --meta ticket=BUG-42
# → meta = {"run_id":"7891234","commit":"abc123","note":"prod deploy","ticket":"BUG-42"}
```

**Rules:**

- `--meta key=value`: split on the **first** `=`; everything after is the value verbatim. `--meta key` (no `=`) is a usage error.
- All values stored as strings. Want a number/bool? Use `$VSYNC_AUDIT_META` with proper JSON.
- Repeated keys: last writer wins (within and across sources, per the priority order above).
- **Size cap:** serialized `meta` ≤ 2 KB. Over the cap → the row is written with `meta = {"_truncated":true}` and a warning to stderr (truncating mid-JSON would break the cell; refusing the whole row would lose the audit event).
- Reserved keys: none. `note` is a convention, not a reservation.

---

## 5. Append protocol (ETag conditional + retry)

Bun's `S3Client` exposes ETag on `stat()` and supports `If-Match` / `If-None-Match` on `write()`. The append is:

```
1. stat(audit.csv) → { etag, exists }
   - if !exists: body = HEADER + "\n" + newRow + "\n"; condition = If-None-Match: "*"
   - if exists:  body = (text()) + newRow + "\n";       condition = If-Match: <etag>
2. put(audit.csv, body, { condition })
3. on 412 Precondition Failed: re-fetch, re-append, retry. Up to 3 attempts total.
4. on any other failure (403, network, 5xx, or 3 conflicts): print
     `warning: failed to record audit entry: <reason>` to stderr.
   Parent command's exit code is unchanged.
```

Best-effort by design: audit is a transparency aid, not a gate. Pull/push must not fail because the log can't be written.

---

## 6. Events logged

| Command | Logged? | `version_ts` |
|---|---|---|
| `vsync pull <env>` | yes | the TS read from `latest` |
| `vsync push <env>` | yes | the TS just written |
| `vsync import <env> <file>` | yes | empty |
| `vsync export <env>` | yes | empty |
| `vsync versions <env>` | **no** — read-only listing |
| `vsync sync <env> …` | **no** — touches external systems, not the vault bytes |
| `vsync init <env>` | **no** — bootstrap; routing config may not exist yet |
| `vsync docs` | **no** — pure-local |
| `vsync audit <env>` | **no** — observing the log shouldn't perturb it |

`export` is logged because minting a `.share` file is itself a sensitive event (it creates a new credential carrier).

---

## 7. Default + opt-out

- **On by default.** Every state-changing command above appends a row.
- **Opt-out per invocation:** `--no-audit` flag skips the append. Useful for scripts.
- **Opt-out per (repo, env):** `cfg.audit.enabled = false`. Set during `init` via `--audit=off` or at the first-time prompt (default-yes).

---

## 8. CLI surface

### 8.1 New verb

```
vsync audit <env> [--limit=N] [--all] [--csv] [--repo=<name>]
```

- Fetch `s3://<bucket>/<repo>/<env>/audit.csv` and print to stdout.
- Default: pretty table, last 50 rows newest-first. The `meta` JSON is unwrapped — `meta.note` shown as its own column, other meta keys collapsed into a single `meta` cell summary (e.g., `ticket=FOO-123, branch=hotfix`).
- `--limit=N`: last N rows.
- `--all`: full log.
- `--csv`: raw CSV passthrough (for piping into shell/`awk`/`jq`/spreadsheets). `meta` cell is the raw JSON.
- `--repo=<name>` as always.

If the file doesn't exist: `(no audit log yet for <repo>/<env>)`. Exit 0.

### 8.2 New flags on existing verbs

| Verb | Flag |
|---|---|
| `init` | `--audit=on\|off` (default `on`) — sets `cfg.audit.enabled` |
| `pull`, `push`, `import`, `export` | `--no-audit` — skips the append for this invocation |
| `pull`, `push`, `import`, `export` | `--note=<text>` — friendly sugar for `--meta note=<text>` (see §4.1). Falls back to `$VSYNC_AUDIT_NOTE`. |
| `pull`, `push`, `import`, `export` | `--meta key=value` (repeatable) — merge into the row's `meta` JSON object. Falls back to / merges with `$VSYNC_AUDIT_META`. |

### 8.3 Verb count

8 → 9. Still tight.

---

## 9. Per-repo config — schema bump

`cfg.version` stays `1`. The new optional block:

```ts
type ConfigFile = {
  version: 1;
  s3: S3Credentials;
  encryption: { salt: string };
  files?: { vaultFolder?: string };
  sync?: { gh?: { repo: string }; gcp?: { project: string } };
  audit?: { enabled: boolean };   // NEW — default true when absent
};
```

`loadConfigFile` treats absent `audit` as `{ enabled: true }`. Share file (`ExportPayload v2`) carries `audit` through if present; teammates importing a share inherit the owner's audit preference.

No config migration needed for users upgrading from 0.3.x — the absent field means "on", which is the default.

---

## 10. File map

| Touched | Why |
|---|---|
| `src/repoconfig.ts` | Add optional `audit` block to `ConfigFile`; `validate()` accepts it; `loadConfigFile` defaults it. |
| `src/audit.ts` *(new)* | `appendAuditRow(cfg, repo, env, action, versionTs?)`, `readAuditLog(cfg, repo, env)`, `formatAuditTable(rows, opts)`. Implements ETag-conditional append + retry. |
| `bin/pull.ts` | After successful unpack, call `appendAuditRow(..., "pull", remoteTs)`. Honor `--no-audit`. |
| `bin/push.ts` | After successful write of `latest`, call `appendAuditRow(..., "push", newTs)`. Honor `--no-audit`. |
| `bin/import.ts` | After successful write of config + keychain, call `appendAuditRow(..., "import", "")`. Honor `--no-audit`. |
| `bin/export.ts` | After successful write of `.share`, call `appendAuditRow(..., "export", "")`. Honor `--no-audit`. |
| `bin/audit.ts` *(new)* | The new verb. ~80 lines. |
| `bin/vsync.ts` | Add `"audit"` to `SUBCOMMANDS`, switch arm, usage text. |
| `bin/init.ts` | Add `--audit=on\|off` flag + first-time prompt; write to `cfg.audit.enabled`. |
| `src/templates/docs.md.ts` | Short section on the audit log + how to read it. |
| `README.md` | `audit` verb in cheat-sheet; one paragraph on what the log captures. |
| `test/audit.test.ts` *(new)* | Unit: CSV format, append, header-on-first-write, ETag retry, RFC 4180 quoting. |
| `test/repoconfig.test.ts` | Round-trip of the new `audit` block; default-true on absent. |
| `package.json` | Version bump to `0.4.0`. |

No deletes. No magic-byte bumps. No schema migration.

---

## 11. Acceptance criteria

1. Fresh `vsync init dev` writes `cfg.audit.enabled: true`. `vsync init dev --audit=off` writes `false`.
2. `vsync push dev` creates `s3://<bucket>/<repo>/dev/audit.csv` with the header + one `push` row including hostname, local IP, os user, git email.
3. `vsync pull dev` on a different machine appends a `pull` row. `vsync audit dev` shows both rows newest-first.
4. Two concurrent `vsync pull dev` invocations from different machines: both rows appear in the final CSV (ETag retry succeeds).
5. With S3 unreachable mid-pull: pull succeeds, audit-append warning printed to stderr, exit code 0.
6. `vsync pull dev --no-audit` does not append. `vsync audit dev` does not append (no recursion).
7. A teammate with `cfg.audit.enabled: false` does not append rows; existing rows from other teammates remain visible to `vsync audit dev`.
8. A user importing a `.share` exported in 0.4.x inherits the `audit` block. Importing a 0.3.x `.share` defaults to `enabled: true`.
9. `vsync` 0.3.x clients reading a bucket that contains `audit.csv` are unaffected; they simply ignore it.
10. RFC 4180 quoting verified on values containing `,`, `"`, and newline.
11. `vsync pull dev --note="ticket FOO-123"` writes `meta = {"note":"ticket FOO-123"}` into the row; round-trips through `vsync audit dev` (note shown as its own column).
12. `vsync pull dev --meta ticket=FOO-123 --meta branch=hotfix` writes `meta = {"ticket":"FOO-123","branch":"hotfix"}`. Repeated keys: last wins.
13. Combining all four sources merges in priority order: `$VSYNC_AUDIT_META` < `$VSYNC_AUDIT_NOTE` < `--meta` < `--note`.
14. `--meta key` (no `=`) is a usage error; `--meta key=val=ue` stores value `val=ue` (split on first `=`).
15. Serialized `meta` > 2 KB → row is written with `meta = {"_truncated":true}` and a warning to stderr.
16. Invalid JSON in `$VSYNC_AUDIT_META` → warning to stderr, env var ignored, other sources still apply.
17. With no `--note`/`--meta`/env var supplied, the row's `meta` cell is empty (not `{}`).
18. RFC 4180 quoting verified on `meta` cells (JSON contains `"` and `,`).

---

## 12. Out of scope (forward look)

These were considered for 0.4 and dropped to keep the release tight. Each is a real follow-up, not a wishlist:

- **Access removal runbook** (per-user IAM keys + revocation flow). Pure docs — no vsync code. Add to `docs` output / README once one team actually does it and we know what details matter.
- **Read-only teammates** via an IAM policy that allows `PutObject` only on `audit.csv` and denies everything else. Works today with the v0.4 audit log already; document when there's demand.
- **Key rotation as a first-class verb** (`vsync rotate <env>`). Needed the moment someone actually has to revoke. Probably 0.4.1.
- **Per-user cryptographic recipients** (`age`/`sops` model — long-lived X25519 keypair per teammate; per-bundle DEK wrapped per recipient). Removes the shared-symmetric-key problem entirely. v0.5 territory; needs a new key format and recipient list management. Comes free with tamper-evident audit (signed rows) as a bonus.
- **Tamper-evident audit** (HMAC-chained rows). Requires a per-user signing key — needs the recipient model above first.
- **Public IP capture.** Trivial column addition; defer until asked.
- **Audit log retention / rotation.** No cap, no auto-archive. Revisit when someone reports a 10 MB `audit.csv`.

---

## 13. Handoff checklist

- [ ] Implement `src/audit.ts` (append + read + format)
- [ ] Wire append into `bin/{pull,push,import,export}.ts` behind `--no-audit` + `cfg.audit.enabled`
- [ ] Add `bin/audit.ts` + dispatcher entry + usage text
- [ ] Add `--audit=on|off` to `bin/init.ts`; first-time prompt
- [ ] Extend `cfg` schema in `src/repoconfig.ts`; tests for default-true round-trip
- [ ] Update `src/templates/docs.md.ts` and `README.md`
- [ ] Tests: `test/audit.test.ts` (format, ETag retry, RFC 4180), round-trip in `test/repoconfig.test.ts`
- [ ] E2E manual: two machines pushing/pulling concurrently → verify `audit.csv` has all rows
- [ ] Version bump → 0.4.0; publish from `main`
