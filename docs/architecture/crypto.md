# Crypto envelopes

vsync has three nested binary formats. Each has a 4-or-more-byte magic prefix so a wrong-passphrase or corrupt-blob error is distinguishable from a wrong-version error.

```
.share file (SLS1) ────────────────────────┐
   │  outer frame:                          │
   │   - 4-byte magic "SLS1"                │
   │   - 16-byte passphrase salt            │
   │   - inner RQE1 envelope ───┐           │
   └────────────────────────────┴───────────┘
                                │
                                ▼
  RQE1 (AES-256-GCM envelope) ──────────────┐
   │  - 4-byte magic "RQE1"                  │
   │  - 12-byte random IV                    │
   │  - 16-byte AES-GCM auth tag             │
   │  - AES-256-GCM ciphertext               │
   │     of one of:                          │
   │       (a) the share file payload        │
   │       (b) RQEM0001 manifest seal ───┐   │
   └──────────────────────────────────────┴───┘
                                          │
                                          ▼
  RQEM0001 (manifest pointer-seal) ───────────┐
   │  - 8-byte magic "RQEM0001"               │
   │  - 1-byte version (0x01)                 │
   │  - 16-byte timestamp string              │
   │     (matches `versions/<ts>.enc` filename)│
   │  - zip payload                            │
   └───────────────────────────────────────────┘
```

## `RQE1` — the workhorse envelope

Used for both the S3 bundle and the inner payload of `.share` files.

- **Cipher:** AES-256-GCM with a 12-byte random IV (per encryption).
- **Key derivation:** PBKDF2-SHA256, 600,000 iterations, over `(keychain-key-bytes, per-repo-salt)`. The salt is generated once at `vsync init` time and stored in plain in the disk config — it's a salt, not a secret.
- **Auth tag:** 16 bytes, validated by `crypto.subtle.decrypt`. Any byte-level tampering → `OperationError`.
- **Magic:** `RQE1` (0x52 0x51 0x45 0x31). On decrypt, the first 4 bytes are sliced off; mismatch → "not a vsync RQE1 envelope" error.

Implementation: `src/crypto.ts`. Test coverage: `test/crypto.test.ts`.

## `RQEM0001` — manifest pointer-seal

The piece that makes "swap `latest` to point at an old bundle" attacks fail at pull time.

- **Why:** an attacker with bucket-write but not the key could rewrite `latest` to point at an earlier `<ts>.enc` (an *older* version). Without an inner check, the next `vsync pull` would happily install the stale bundle.
- **What:** before encrypting, vsync wraps `(timestamp, zip-bytes)` with a magic prefix. So the timestamp is **inside** the AES-GCM ciphertext, sealed by the auth tag.
- **Pull-side check:** decrypt → strip magic + version → read `embedded_ts` → compare with the `remote_ts` we read from `latest`. Mismatch → refuse + report.

So `latest` can be rewritten, but the rewrite has to point at a bundle whose embedded timestamp matches the rewrite. That requires the AES key. Without the key, the attack collapses.

Implementation: `src/manifest.ts`. Test coverage: `test/manifest.test.ts`.

## `SLS1` — share file outer frame

A `.share` file is:

```
SLS1 magic (4)
  passphrase salt (16)
  RQE1 envelope of the export payload
```

The **passphrase** (the 4-word phrase you send on a separate channel) is run through PBKDF2-SHA256, 600,000 iterations, with the salt above, to produce the AES-256 key for the inner `RQE1`.

The **export payload** is a JSON object with version, config (s3 + encryption + files + sync + audit blocks), and the raw AES key (base64). The teammate's `vsync import` decrypts this, writes the config to disk, and saves the key to the keychain.

Implementation: `src/sharefile.ts`. Test coverage: `test/sharefile.test.ts`.

## Why these specific magics

- `RQE1` — historical magic from an earlier codename of this project. Kept for wire compatibility.
- `RQEM0001` — `RQE` family + `M` for manifest + `0001` for version. Lets a future format bump (`RQEM0002`) coexist with old clients refusing it cleanly.
- `SLS1` — Share-LayerSeal v1. Distinct prefix so a `.share` file mis-read as a `RQE1` bundle errors usefully.

## Why PBKDF2 with 600k iterations

- Matches OWASP's 2023 recommendation for PBKDF2-SHA256.
- Fast enough on a developer laptop (~250ms on M1).
- Slow enough that brute-forcing a leaked `.share` passphrase remains infeasible at common entropy (4 dictionary words ≈ 52 bits).
- We don't use Argon2id (would be better) because it'd require shipping a wasm dependency, and the wins over PBKDF2-600k aren't load-bearing for this threat model.

## Don't break the magic bytes

Any change to a magic prefix = breaks every existing deployment. If you ever need to bump:

1. Add a new magic (`RQE2` or `RQEM0002`).
2. Pull-side: detect old vs. new at the prefix, decode both.
3. Push-side: write the new format only.
4. Keep the old reader code path for at least one minor release so users have time to upgrade.

Don't change a magic in-place. Ever.

---

[Next: Audit append protocol →](/architecture/audit-protocol)
