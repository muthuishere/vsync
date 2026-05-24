# Crypto envelopes

vsync has three nested binary formats. Each has a 4-or-more-byte magic prefix so a wrong-passphrase or corrupt-blob error is distinguishable from a wrong-version error.

```
.share file (SLS1) ────────────────────────┐
   │  outer frame:                          │
   │   - 4-byte magic "SLS1"                │
   │   - 1-byte saltLen                     │
   │   - L-byte salt (ASCII base64 string)  │
   │   - inner RQE1 envelope ───┐           │
   └────────────────────────────┴───────────┘
                                │
                                ▼
  RQE1 (AES-256-GCM envelope) ──────────────┐
   │  - 4-byte magic "RQE1"                  │
   │  - 12-byte random IV (nonce)            │
   │  - N-byte AES-256-GCM ciphertext        │
   │  - 16-byte GCM auth tag (concatenated)  │
   │     plaintext is one of:                │
   │       (a) the share-file ExportPayload  │
   │       (b) RQEM0001 manifest seal ───┐   │
   └──────────────────────────────────────┴───┘
                                          │
                                          ▼
  RQEM0001 (manifest pointer-seal) ───────────┐
   │  - 8-byte magic "RQEM0001"               │
   │  - 1-byte version (0x01)                 │
   │  - 16-byte timestamp string              │
   │     (matches `versions/<ts>.enc` filename)│
   │  - zip payload (the actual vault folder) │
   └───────────────────────────────────────────┘
```

## `RQE1` — the workhorse envelope

Used for both the S3 bundle and the inner payload of `.share` files.

### Byte layout

```
offset  size      field
 0      4         magic = ASCII "RQE1" = 0x52 0x51 0x45 0x31
 4      12        IV (cryptographically random; one per encryption)
16      variable  AES-256-GCM ciphertext
end-16  16        AES-GCM authentication tag
```

WebCrypto's `crypto.subtle.encrypt({name:"AES-GCM", iv}, key, plaintext)` returns the ciphertext **with the auth tag concatenated**. vsync writes that buffer verbatim after the IV — no separate tag field, no reordering.

### Crypto choices

- **Cipher:** AES-256-GCM. The 256-bit AES key is the output of the KDF.
- **IV:** 12 bytes from `crypto.getRandomValues`. **A fresh IV per encryption.** Never reuse an IV with the same key.
- **Auth tag:** 16 bytes, validated by `crypto.subtle.decrypt`. Any byte-level tamper of magic / IV / ciphertext / tag → `OperationError` from WebCrypto, which `src/crypto.ts` translates into a `BundleCorruptError` or `WrongPassphraseError` depending on the context.
- **Magic check:** decrypt slices off the first 4 bytes and asserts `RQE1`. Mismatch → "not a vsync RQE1 envelope" — distinguishable from "wrong passphrase".

### Key derivation — PBKDF2 specifics

The AES-256 key comes from PBKDF2-SHA256 over `(password, salt)` with 600,000 iterations.

| Where used | Password input | Salt input |
|---|---|---|
| S3 bundle (CLI side) | base64-decoded keychain AES key (32 bytes) | `cfg.encryption.salt` (the 24-char ASCII string, UTF-8 bytes fed verbatim) |
| S3 bundle (runtime lib) | `VSYNC_PASSPHRASE` (utf-8 bytes verbatim — no trim on the env-var path) | `salt` from the `VSYNC_CONFIG` blob (UTF-8 bytes of the 24-char string) |
| `.share` file | passphrase typed by the user (utf-8 bytes verbatim) | 16-byte salt embedded in the `SLS1` outer frame |

The "salt is the UTF-8 bytes of a base64-looking string" convention is the **load-bearing detail** that breaks naïve readers. The field is stored as a 24-character base64url string in the config file. PBKDF2 sees the **string bytes**, not the base64-decoded bytes. Reasons:

- Historical artefact — `vsync init` writes the salt as a base64-encoded random buffer for storage compactness.
- The CLI's own `src/crypto.ts::deriveKey` feeds the string directly to PBKDF2 (no decode). All test vectors in `docs/specs/test-vectors/rqe1-decrypt/` are generated this way.
- A future `vsync-cfg-v2` blob may rename the field to `salt_string` to signal the opacity explicitly. For now: **do not base64-decode the salt** in any reader.

PBKDF2-SHA256 with 600k iterations:

- Matches OWASP's 2023 recommendation.
- ~250ms on an Apple M1 — fast enough for boot, slow enough that brute-forcing a leaked `.share` passphrase remains infeasible at common entropy (4 dictionary words ≈ 52 bits).
- We don't use Argon2id (would be better) because it'd require a wasm dependency, and the wins over PBKDF2-600k aren't load-bearing for this threat model.

Implementation: `src/crypto.ts`. Test coverage: `test/crypto.test.ts`. Conformance vectors: `docs/specs/test-vectors/rqe1-decrypt/`.

## `RQEM0001` — manifest pointer-seal

The piece that makes "swap `latest` to point at an old bundle" attacks fail at pull time.

### Byte layout

```
offset  size      field
 0      8         magic = ASCII "RQEM0001"
 8      1         version byte = 0x01
 9      16        timestamp string (ASCII)
                  format: "YYYYMMDD-HHMMSS" or "<14-char-stamp>"
                  matches versions/<ts>.enc filename
25      variable  zip payload (the encrypted vault contents)
```

The whole `RQEM0001` blob is then wrapped in an `RQE1` envelope before upload — so the timestamp is **inside** the AES-GCM ciphertext, sealed by the auth tag.

### Why this exists

An attacker with bucket-write but not the key could rewrite `latest` to point at an earlier `<ts>.enc` (an *older* version). Without an inner check, the next `vsync pull` would happily install the stale bundle.

### Pull-side verification

```
1. Read `latest` pointer → remoteTs string
2. Fetch versions/<remoteTs>.enc
3. RQE1-decrypt the bundle
4. Inside, find RQEM0001 magic + version + embeddedTs
5. Compare embeddedTs === remoteTs. Mismatch → refuse + report.
6. Unzip the payload.
```

The pointer file can be rewritten freely, but the rewrite has to point at a bundle whose **embedded** timestamp matches — which requires re-encrypting, which requires the AES key. Without the key, the attack collapses.

Implementation: `src/manifest.ts`. Test coverage: `test/manifest.test.ts`.

### The `meta` cell on the manifest

`v0.4` added a `meta` JSON cell on the manifest object (not in the bundle ciphertext). It carries:

```json
{
  "gen": 4,            // monotonic generation counter; bumps on rotate-passphrase
  "prev_gen": 3,       // for forensic chain-of-rotation
  "rotated_at": "2026-05-23T11:42:01.234Z"  // ISO timestamp of last rotation
}
```

The `gen` integer is what the runtime libs expose as `generation()`. It's read from the **outer** manifest object's metadata, not from inside the encrypted blob — which means `remote_generation()` is a cheap HEAD that doesn't need the passphrase.

Adding fields to `meta` is forward-compat as long as existing readers ignore unknowns (the v0.4 contract).

## `SLS1` — share file outer frame

A `.share` file is:

```
offset  size      field
 0      4         magic = ASCII "SLS1"
 4      1         saltLen (0..255)
 5      saltLen   salt (ASCII base64 string, used as UTF-8 bytes for PBKDF2)
 5+L    variable  inner RQE1 envelope of the ExportPayload
```

The **passphrase** (the 4-word phrase you send on a separate channel) is run through PBKDF2-SHA256 / 600,000 iterations with the salt above to produce the AES-256 key for the inner `RQE1`.

The **export payload** plaintext is:

```typescript
type ExportPayload = {
  version: 1;
  repo: string;       // e.g. "myapp"
  env: string;        // e.g. "dev"
  config: ConfigFile; // s3 + encryption + files + sync + audit blocks
  key: string;        // the AES key the recipient will store in their keychain (base64)
};
```

The teammate's `vsync import` decrypts this, writes the config to disk, and saves the key to the keychain. The `.share` file itself is single-use in the sense that nothing keeps state about it — once imported, you can delete it.

Implementation: `src/sharefile.ts`. Test coverage: `test/sharefile.test.ts`.

## Why these specific magics

- **`RQE1`** — historical magic from an earlier codename of this project. Kept for wire compatibility. Pre-1.0 had no constraints on the magic; this is what shipped.
- **`RQEM0001`** — `RQE` family + `M` for manifest + `0001` for version. Lets a future format bump (`RQEM0002`) coexist with old clients refusing it cleanly. The version byte at offset 8 is currently redundant with the magic; reserved for in-family bumps.
- **`SLS1`** — Share-LayerSeal v1. Distinct prefix so a `.share` file mis-read as an `RQE1` bundle errors usefully.

## `vsync-cfg-v1:` — the runtime-token blob

Not a binary envelope; a text-encoded transport format for `VSYNC_CONFIG`.

### Format

```
vsync-cfg-v1:<base64url(no-pad)( gzip( utf8( JSON ) ) )>
```

- **Magic prefix:** ASCII `vsync-cfg-v1:`. Required. Wrong prefix → `ConfigMissingError` with a hint that the operator likely passed raw JSON or a different version blob.
- **Encoding:** base64url (RFC 4648 §5), **no padding**. Keeps the blob safe in env vars, YAML, shell args, and CLI flags without quoting. Standard base64 (with `+`, `/`, `=`) MUST NOT be accepted by readers.
- **Compression:** gzip (mtime cleared, level 6) for compactness. The plaintext JSON is typically 250-400 bytes; gzipped ~150-250.

### Inner JSON

```json
{
  "v": 1,
  "endpoint": "https://s3.amazonaws.com",
  "region": "us-east-1",
  "bucket": "acme-secrets",
  "accessKeyId": "AKIA...",
  "secretAccessKey": "...",
  "prefix": "myapp/prod/",
  "env": "prod",
  "salt": "<24-char base64url string>",
  "iterations": 600000
}
```

- `v: 2` (or higher) → `ConfigUnsupportedVersionError` on a v1 reader. No silent downgrade.
- Unknown fields ignored on read (forward-compat with field additions inside `v: 1`).
- `salt` is the same string as the CLI's `cfg.encryption.salt`. PBKDF2 sees the UTF-8 bytes verbatim (see above).

Implementation: `bin/runtime-token.ts` (writer), runtime libs (readers). Spec: [v0.10 §4](/specs/v0.10-runtime-token-cli).

## Worked decrypt example

The full chain from a leaked `(bucket, blob, passphrase)` to plaintext, conceptually:

```
1. Read blob bytes from S3 at `<prefix>v=<latestTs>`            (network)
2. Strip RQE1 magic (4 bytes)
3. Read IV (12 bytes)
4. Strip auth tag (last 16 bytes) — separated for AES-GCM API
5. Derive AES-256 key:
     key = PBKDF2-SHA256(
       password = utf8(VSYNC_PASSPHRASE),
       salt     = utf8(<24-char-salt-string>),
       iter     = 600000,
       keyLen   = 32
     )
6. AES-256-GCM decrypt with (key, IV, ciphertext, tag, no AAD) → plaintext
   ↳ wrong passphrase → tag mismatch → WrongPassphraseError
   ↳ corrupt bytes    → tag mismatch → BundleCorruptError
   ↳ wrong magic      → caught before this step → BundleCorruptError
7. Plaintext starts with RQEM0001 magic; strip + version byte + 16-byte ts
8. Compare embeddedTs === latestTs (pulled from manifest pointer in step 1)
9. The rest is a ZIP archive; extract → vault contents on disk (or in-memory map for runtime libs)
```

The runtime libs build an in-memory `{ key → value }` map from the unzipped `.env.<env>` file, plus a `{ name → bytes }` map for any other vault files. `get_env` / `get_as_content` are constant-time lookups against those maps.

## Don't break the magic bytes

Any change to a magic prefix = breaks every existing deployment. If you ever need to bump:

1. Add a new magic (`RQE2` or `RQEM0002`).
2. Pull-side: detect old vs. new at the prefix, decode both during a transition release.
3. Push-side: write the new format only.
4. Keep the old reader code path for at least one minor release so users have time to upgrade.
5. Drop the old reader in the next major.

Don't change a magic in-place. Ever.

## Out-of-scope hardening (intentional)

- **No HSM / TPM integration.** The OS keychain (via `Bun.secrets`) is the strongest secret store we can use with no extra deps.
- **No client-side certificate auth to S3.** Standard IAM access-key pairs only.
- **No per-recipient cryptography** (à la `age` / `sops`). Every teammate shares the same `(repo, env)` AES key. Per-recipient `X25519` is parked for v0.5+ — needs the recipient model from [v0.4 spec §12](/specs/v0.4-audit-log).

## Where to go next

- [Audit append protocol →](/architecture/audit-protocol)
- [Storage layout →](/architecture/storage-layout)
- [Security model →](/architecture/security)
- [`v0.2-secret-lib` spec — original crypto envelope spec](/specs/v0.2-secret-lib)
- [`v0.12-vsync-s3-client` spec — runtime-side decryption](/specs/v0.12-vsync-s3-client)
