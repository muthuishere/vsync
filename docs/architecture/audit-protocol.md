# Audit append protocol

The audit log is a single CSV at `s3://<bucket>/<repo>/<env>/audit.csv`, append-only by convention. Multiple machines can append concurrently and not lose rows. This page explains how.

## The naive approach (doesn't work)

```
1. GET audit.csv
2. append your row
3. PUT audit.csv
```

Two machines pulling at the same instant both read the same content, both append their row, both PUT. **Last writer wins** — one of the two rows is lost.

## What vsync does

ETag-conditional PUT with retry:

```
1. stat(audit.csv) → { etag, exists }
   - if !exists:    body = HEADER + "\n" + newRow + "\n"
                    condition = If-None-Match: "*"
   - if exists:     body = (current text) + newRow + "\n"
                    condition = If-Match: <etag>
2. PUT audit.csv with the condition header.
3. On 412 Precondition Failed (another writer landed first): re-fetch, re-append, retry.
   Up to 3 attempts total.
4. On 403 AccessDenied: silently skip (read-only IAM key).
5. On any other failure: print warning to stderr; do NOT fail the parent command.
```

Why this works: S3's conditional headers are checked **atomically server-side**. If your ETag matches the current object's ETag, your PUT succeeds; if not (because another writer landed between your `stat()` and your `PUT`), you get 412 and try again with the new content + new ETag.

Three retries is enough in practice — even on a 20-person team, the probability of three concurrent writers racing in the same ~500ms window is negligible.

## Why a hand-rolled SigV4 PUT

`Bun.S3Client` (1.3.0) doesn't expose `If-Match` / `If-None-Match` on its `write()` method. The spec assumed it did; in practice it doesn't. So `src/audit.ts` reads via `Bun.S3Client` (which handles ETag retrieval fine) and writes via a minimal hand-signed SigV4 `fetch` PUT (the only place conditional headers matter).

The signer is ~80 lines in `src/audit.ts::sigv4Put`. It does:

- Path-style URL: `https://<endpoint>/<bucket>/<key>`
- Lowercase, sorted canonical headers
- SHA-256 payload hash + HMAC-SHA256 key derivation chain
- `Authorization: AWS4-HMAC-SHA256 …`

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

- 403 → silent (read-only teammate; expected)
- 5xx / network / persistent 412 → `warning: failed to record audit entry: <reason>` to stderr
- Parent command's exit code is **unchanged**

The audit log can lose the occasional row in extreme contention. The compensating story: this isn't a tamper-evident audit log — anyone with bucket-write can edit the CSV. Losing a row in a transient failure is in the same category as someone deleting one. Both are accepted limitations of the threat model.

For tamper-evidence we'd need signed/chained rows + per-user signing keys, which would require the recipient model from [v0.4 spec §12](/specs/v0.4-audit-log). Out of scope for 0.x.

## The `meta` cell — RFC 4180 in practice

The `meta` column is JSON, embedded in CSV. RFC 4180 says: any field containing `,`, `"`, or `\n` must be wrapped in `"` and any internal `"` doubled. So a meta cell like `{"note":"ship it"}` becomes:

```
"{""note"":""ship it""}"
```

Excel, Numbers, `csv.reader` in Python — all handle this. `jq` doesn't read CSV natively, but `vsync audit --csv | python -c 'import csv,sys,json; …'` works fine.

## Race-free alternative we didn't pick

**Per-event objects.** Each event writes a small unique object at `audit/<ts>-<rand>.csv`. `vsync audit` would list + concatenate. Zero race condition, ever. But:

- 100 pushes per day per (repo, env) = 100 small objects per day. After a year, 36k objects to list. Slow.
- Concat at read-time is more complex than reading one CSV.
- Most teams don't have enough contention for the ETag-retry approach to lose rows.

The single-CSV approach wins on simplicity, with the ETag-retry covering 99.9% of contention scenarios. The per-event-objects alternative remains valid if real-world data shows the row-loss rate is unacceptable.

---

[Next: Repo identity →](/architecture/repo-identity)
