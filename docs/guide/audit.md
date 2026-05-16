# Audit log

Every `push`, `pull`, `import`, and `export` appends one row to `s3://<bucket>/<repo>/<env>/audit.csv` so the team can see **who did what, from where, and when**.

```bash
vsync audit dev                      # pretty table, newest 50 rows
vsync audit dev --limit=10           # last 10
vsync audit dev --all                # full log
vsync audit dev --csv                # raw CSV for jq/awk/spreadsheet
```

Pretty output:

```
TS                        ACTION  VERSION          USER         HOST                       NOTE                META
------------------------  ------  ---------------  -----------  -------------------------  ------------------  --------------
2026-05-16T11:39:49.145Z  pull    20260516-113343  muthu        Muthus-MacBook-Pro.local   0.4 post-fix        fix=etag-strip
2026-05-16T11:33:45.684Z  push    20260516-113343  muthu        Muthus-MacBook-Pro.local   0.4 sigv4 smoke     ticket=AUDIT-1
```

## Columns

```
ts, action, version_ts, hostname, local_ip, os_user, git_email, vsync_version, bun_version, meta
```

| Column | Source |
|---|---|
| `ts` | `new Date().toISOString()` at append time |
| `action` | one of `pull`, `push`, `import`, `export` |
| `version_ts` | the bundle TS the action read/wrote (empty for `import` / `export`) |
| `hostname` | `os.hostname()` |
| `local_ip` | first non-loopback IPv4 |
| `os_user` | `$USER` / `$USERNAME` |
| `git_email` | `git config --get user.email` (empty if not in a git repo) |
| `vsync_version` | `package.json::version` |
| `bun_version` | `process.versions.bun` |
| `meta` | user-supplied JSON cell (see below) |

No public IP — slow + privacy-touchy. Easy to add later if anyone asks.

## The `meta` cell

A single JSON object — your expandable escape hatch. Vsync neither interprets keys nor enforces a schema; it serialises and stores.

**Four input paths**, merged in this priority order (last wins):

```
$VSYNC_AUDIT_META   <   $VSYNC_AUDIT_NOTE   <   --meta key=value   <   --note=<text>
   ↑ JSON base          ↑ {note: <text>}        ↑ k=v (repeatable)    ↑ {note: <text>}
```

- `--note=<text>` is sugar — internally just `--meta note=<text>`.
- `--meta key=value` is repeatable: `--meta ticket=BUG-42 --meta branch=hotfix`.
- Env-var twins of both, great for CI.

### CI ergonomics

```bash
VSYNC_AUDIT_META='{"run_id":"7891234","commit":"abc123"}' \
VSYNC_AUDIT_NOTE="prod deploy" \
vsync pull production --meta ticket=BUG-42
# → meta = {"run_id":"7891234","commit":"abc123","note":"prod deploy","ticket":"BUG-42"}
```

### Limits

- Max 2 KB serialised. Over → row is written with `meta = {"_truncated":true}` and a warning to stderr.
- `--meta key` (no `=`) → usage error, exit 1.
- Repeated keys → last wins (within a single source and across sources).

## Default behaviour

- **On by default.** Every state-changing op appends.
- **Opt-out per invocation:** `--no-audit` skips the append.
- **Opt-out per (repo, env):** `vsync init <env> --audit=off` sets `cfg.audit.enabled = false`.
- **Best-effort:** an audit-write failure prints a warning to stderr but **never fails the parent command**. Pull and push are atomic; audit is just bookkeeping.

## What audit log is — and is not

| | |
|---|---|
| **Is** | A transparency aid. A CSV every teammate appends to so the team can see push/pull activity. |
| **Is not** | Tamper-evident. A bad actor with bucket-write can rewrite the CSV. Tamper-evidence needs signed rows + per-user keys — that's out of scope. |
| **Is not** | A gate. If S3 is unreachable, your pull still succeeds. |
| **Is not** | A way to reclaim already-pulled secrets. Once a teammate has pulled, they have a local copy — only key rotation invalidates future pulls. |

See [Audit append protocol](/architecture/audit-protocol) for how the ETag-conditional write works under concurrency.

---

[Next: Command reference →](/guide/commands)
