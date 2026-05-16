# Install

```bash
bun install -g @muthuishere/vsync     # or:  npm install -g @muthuishere/vsync
vsync --help
```

After install, `vsync` is on your PATH. No shell-rc edits.

## Requirements

- **Bun ≥ 1.2.21** must be on PATH — the bin file's shebang is `#!/usr/bin/env bun`, so even if you installed via `npm install -g`, the OS needs `bun` to execute the entry point. Most users have Bun anyway; if not, see [bun.sh](https://bun.sh).
- An **OS keychain backend** — macOS Keychain, Linux libsecret (`gnome-keyring`, `keepassxc-secret-service`, etc.), or Windows Credential Manager. Required for storing the per-(repo, env) AES key. No-keychain fallback is intentionally not provided.
- An **S3-compatible bucket** (AWS S3, Hetzner Object Storage, MinIO, Cloudflare R2, Backblaze B2 via S3 API). vsync only does SDK-level operations — `PutObject`, `GetObject`, `HeadObject`, `ListObjectsV2`.

## Don't want to install?

```bash
bunx @muthuishere/vsync <subcommand>
```

Same code path. Runs from npm cache each time. Slower per-invocation; fine for trying it out.

## Platform support

| Piece | macOS | Linux | Windows |
|---|:---:|:---:|:---:|
| Global install (npm or bun) | ✓ | ✓ | ✓ |
| `Bun.secrets` keychain | ✓ Keychain | ✓ libsecret | ⚠ Credential Manager — supported per Bun docs, less battle-tested |
| `vsync use` symlinks | ✓ | ✓ | ⚠ Requires Developer Mode (Settings → Privacy & security → For developers) or elevated terminal |
| `chmod 0600` on disk config | ✓ POSIX bits | ✓ POSIX bits | ⚠ Maps to read-only attribute — protection comes from `%APPDATA%` user scope, not mode bits |
| Git / `gh` / `gcloud` shell-outs | ✓ | ✓ | ✓ |
| S3 push/pull (incl. SigV4 audit append) | ✓ | ✓ | ✓ |

The Windows path is **conceptually supported but untested in our CI**. If you hit issues, file at [github.com/muthuishere/vsync/issues](https://github.com/muthuishere/vsync/issues).

## Develop vsync locally

```bash
git clone git@github.com:muthuishere/vsync.git
cd vsync
bun install
bun test                       # 184 tests, ~20s
bun bin/vsync.ts --help        # run the local source
```

There's no build step. `bun test` is the only correctness gate.

---

[Next: What lives in the vault →](/guide/vault)
