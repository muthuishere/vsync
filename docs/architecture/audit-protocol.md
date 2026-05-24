# Audit append protocol

The audit log is a single CSV at `s3://<bucket>/<repo>/<env>/audit.csv`, append-only by convention. Multiple machines can append concurrently and not lose rows. This page explains how — and where the protocol's limits are.

## The naive approach (doesn't work)

```
1. GET audit.csv
2. append your row
3. PUT audit.csv
```

Two machines pulling at the same instant both read the same content, both append their row, both PUT. **Last writer wins** — one of the two rows is lost.

## What vsync does — ETag-conditional PUT with retry

```
1. stat(audit.csv) → { etag, exists }
   - if !exists:    body = HEADER + "\n" + newRow + "\n"
                    condition = If-None-Match: "*"
   - if exists:     body = (current text) + newRow + "\n"
                    condition = If-Match: <etag>
2. PUT audit.csv with the condition header.
3. On 412 Precondition Failed (another writer landed first):
     re-fetch, re-append, retry. Up to 3 attempts total.
4. On 403 AccessDenied: silently skip (read-only IAM key).
5. On any other failure: print warning to stderr; do NOT fail the parent command.
```

Why this works: S3's conditional headers are checked **atomically server-side**. If your ETag matches the current object's ETag, your PUT succeeds; if not (because another writer landed between your `stat()` and your `PUT`), you get 412 and try again with the new content + new ETag.

Three retries is enough in practice — even on a 20-person team, the probability of three concurrent writers racing in the same ~500ms window is negligible.

## Concurrency sequence diagram

```
Machine A           S3 bucket           Machine B
   │                    │                   │
   │── stat(audit.csv) ─>                   │
   │<──── etag=abc ─────│                   │
   │                    │<── stat ──────────│
   │                    │───── etag=abc ───>│
   │                    │                   │
   │── append row A     │       append row B│
   │── PUT body+rowA    │                   │
   │     If-Match: abc ─>                   │
   │<───── 200 OK ──────│                   │
   │     (new etag=def) │                   │
   │                    │<── PUT body+rowB ─│
   │                    │      If-Match: abc│
   │                    │───── 412 ────────>│
   │                    │                   │
   │                    │<── stat ──────────│  (retry)
   │                    │───── etag=def ───>│
   │                    │<── PUT body+rowA+rowB ─
   │                    │      If-Match: def│
   │                    │───── 200 ────────>│
   │                    │                   │
```

Final state on the bucket: both rows landed. Row A first, row B second. The CSV is well-ordered chronologically by `ts` for non-conflicting writes; under retry, the row ordering reflects the **commit** order, not the action's `ts`.

## Why a hand-rolled SigV4 PUT

`Bun.S3Client` (1.3.0) doesn't expose `If-Match` / `If-None-Match` on its `write()` method. The spec assumed it did; in practice it doesn't. So `src/audit.ts` reads via `Bun.S3Client` (which handles ETag retrieval fine) and writes via a minimal hand-signed SigV4 `fetch` PUT (the only place conditional headers matter).

The signer is ~80 lines in `src/audit.ts::sigv4Put`. It does:

- **Path-style URL** — `https://<endpoint>/<bucket>/<key>` (not virtual-hosted style; works with more S3-compatible providers).
- **Lowercase, sorted canonical headers** — per the AWS SigV4 spec.
- **SHA-256 payload hash** — for the canonical request and the signed body integrity check.
- **HMAC-SHA256 key derivation chain** — `kSecret → kDate → kRegion → kService → kSigning`.
- **`Authorization: AWS4-HMAC-SHA256 …`** header.

If a future Bun release adds `ifMatch` / `ifNoneMatch` to `S3Options`, the signer can be deleted and replaced with a one-liner `client.file(key).write(body, { ifMatch })`. The `AuditClient` interface in `src/audit.ts` insulates the rest of the code from the implementation choice.

## The Hetzner / Ceph quirk

Discovered during E2E: **Hetzner Object Storage (Ceph RGW) rejects `If-Match` headers with quoted ETag values** — strict-AWS-style — and returns `412 Precondition Failed` even when the ETag actually matches.

The fix: strip the surrounding quotes before sending. AWS S3 and MinIO accept either form; Ceph wants unquoted. So `src/audit.ts` strips quotes universally:

```ts
headers["if-match"] = condition.ifMatch.replace(/^"|"$/g, "");
```

Documented inline in the function. The quirk is real and reproducible — verified by sending the same SigV4 request twice (quoted then unquoted) against the same bucket.

## Best-effort, not a gate

Audit is **bookkeeping**, not a precondition. If the audit write fails:

| Class | Behavior | Why |
|---|---|---|
| 403 AccessDenied | silent — no warning | Read-only IAM key. Expected for teammates restricted from `audit.csv`. |
| 5xx / network / TLS | warning to stderr | Transient. Push/pull still succeeded. |
| Persistent 412 (× 3) | warning to stderr | Heavy concurrency. Your row was dropped. Others probably landed. |
| Malformed response | warning to stderr | Unexpected; investigate the bucket impl. |

The parent command's exit code is **unchanged**. Pull/push must not fail because the log can't be written.

The audit log can lose the occasional row in extreme contention. The compensating story: this isn't a tamper-evident audit log — anyone with bucket-write can edit the CSV. Losing a row in a transient failure is in the same category as someone deleting one. Both are accepted limitations of the threat model.

For tamper-evidence we'd need signed/chained rows + per-user signing keys, which would require the recipient model from [v0.4 spec §12](/specs/v0.4-audit-log). Out of scope for 0.x.

## Replay safety

A bad actor with bucket-write could:

- Delete rows (`PutObject` with edited content; no protection beyond bucket versioning).
- Insert rows with backdated `ts` (CSV columns aren't signed; nothing distinguishes a real row from a forgery).
- Reorder rows on PUT (since the protocol re-fetches the whole file).

None of these are detected by the protocol. If you need stronger guarantees:

- **Bucket-level versioning** — every PUT creates a new version; you can audit changes via the S3 versions list. Doesn't prevent forgery but makes it auditable.
- **Bucket-side access logs** (AWS S3 server access logs, equivalent on other providers) — independent of vsync, hard for a bad actor with content write to also hide bucket-management activity. Cross-reference these with `audit.csv` during incident review.
- **Read-only teammates** — give most teammates an IAM key without `PutObject` on `audit.csv` (but with `PutObject` on the bundle prefix); only the owner has write to the audit log. This works today but reduces the audit log to "what the owner did", which may or may not be useful.

## The `meta` cell — RFC 4180 in practice

The `meta` column is JSON, embedded in CSV. RFC 4180 says: any field containing `,`, `"`, or `\n` must be wrapped in `"` and any internal `"` doubled. So a meta cell like `{"note":"ship it"}` becomes:

```
"{""note"":""ship it""}"
```

Excel, Numbers, `csv.reader` in Python — all handle this. `jq` doesn't read CSV natively, but `vsync audit --csv | python -c 'import csv,sys,json; …'` works fine.

Meta cell size cap: **2 KB serialised**. Over the cap → the row is written with `meta = {"_truncated":true}` and a warning to stderr. Truncating mid-JSON would break the cell; refusing the whole row would lose the audit event. The truncate-with-flag strategy preserves the row, makes the truncation visible, and the operator can re-record with a slimmer meta if they care.

## Header-on-first-write

The very first `vsync push` for an env creates `audit.csv` with the header row + the push row. Detection is by `If-None-Match: "*"` — the PUT succeeds only if the object doesn't exist yet.

Subsequent writes use `If-Match: <etag>` and append.

Migration consideration: if you upgrade from a pre-0.4 vsync (no audit), your bucket has no `audit.csv` yet. The first 0.4+ push creates it. No migration script needed.

## Performance characteristics

Per audit-append:

- 1 HEAD request (`stat()` to get the ETag).
- 1 GET request (fetch current content to re-append).
- 1 PUT request (write the new content with the condition header).
- = 3 round trips on the happy path.

For a typical 50KB audit log (~1000 rows) on a Hetzner bucket from a developer laptop, the whole append takes ~400ms. The audit append happens **after** the bundle PUT/GET in `push`/`pull`, so it doesn't delay the actual secret rotation.

Don't expect the audit log to scale to 100k rows — at that size, the GET+PUT cycle slows linearly. If you're seeing operational issues, switch to the per-event-objects pattern below.

## Race-free alternative we didn't pick

**Per-event objects.** Each event writes a small unique object at `audit/<ts>-<rand>.csv`. `vsync audit` would list + concatenate. Zero race condition, ever. But:

- 100 pushes per day per (repo, env) = 100 small objects per day. After a year, 36k objects to list. Slow.
- Concat at read-time is more complex than reading one CSV.
- Most teams don't have enough contention for the ETag-retry approach to lose rows.

The single-CSV approach wins on simplicity, with the ETag-retry covering 99.9% of contention scenarios. The per-event-objects alternative remains valid if real-world data shows the row-loss rate is unacceptable — switching is a wire-compatible change (`vsync audit <env>` can read either layout).

## Where to go next

- [Storage layout →](/architecture/storage-layout)
- [Repo identity →](/architecture/repo-identity)
- [Security model →](/architecture/security)
- [`v0.4-audit-log` spec — wire format + acceptance criteria](/specs/v0.4-audit-log)
- [User-facing guide: Audit log](/guide/audit)
