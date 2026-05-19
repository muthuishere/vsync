---
name: vsync-skill
---

# Recipes — opinionated presets for common operations

Reach for a recipe when the user asks for a multi-step operation that doesn't map to a single `vsync` verb. Each recipe lists the **trigger phrases**, the **inputs to collect**, the **security warning** to surface (if applicable), the **command sequence**, and the **cleanup checklist**.

Every recipe expects vsync to be on PATH and a `~/.config/vsync/defaults` file to exist (pre-fills S3 creds at `init` time). If either is missing, route to `references/failure-modes.md` instead.

---

## EXPORT-1: Export with explicit `.share` + passphrase destinations

**Trigger phrases:** "export the vault for X", "give me the share file + passphrase", "I need to onboard a teammate / provision a VPS / write to AirDrop / save the bundle to ~/Downloads", "save the passphrase to <path>", "put the .share at <path>", "export and put both in <folder>".

### What this recipe does

vsync's `export` verb writes a `.share` file (default `./<repo>-<env>.share`) and prints the auto-generated passphrase to stdout. This recipe **always asks the user for two paths separately** — one for the `.share`, one for the passphrase — so the default behaviour reinforces the two-channel threat model. If the user picks the same parent folder for both, surface the warning before proceeding.

### Inputs to collect — ALWAYS ask both, separately

| Prompt | Example value | Notes |
|---|---|---|
| **Repo path** | `/Users/me/projects/myapp` | The git repo to export from. The agent `cd`s here so v0.9 resolves the canonical name from `git remote.origin.url`. |
| **Env name** | `production`, `dev`, `local`, `<custom>` | Ask if not obvious from the user's request. Default for VPS provisioning is `production`. |
| **`.share` destination** | `~/Desktop/infra-vps/myapp-prod.share` | Full path, including filename. If a directory is given, append `<repo>-<env>.share`. |
| **Passphrase destination** | `~/Documents/passphrases/myapp-prod.txt` | Full path, including filename. If a directory is given, append `<repo>-<env>.passphrase.txt` (NOT `.share` — avoid lookalike names). |

Do NOT default both to the same folder. If the user volunteers one path but not the other, ask for the second explicitly — phrase it as "and where should the passphrase go?" so the prompt itself signals these should be different.

### ⚠️ Conditional warning — fire ONLY when both destinations share a parent folder

Compute `dirname(<share-dest>) == dirname(<passphrase-dest>)`. If equal, surface this **before** running any command:

> The `.share` file and the passphrase are about to land in the same folder. That breaks vsync's two-channel threat model — anything that reads the folder gets full vault access. There's no defense-in-depth left.
>
> This is acceptable ONLY when:
>
> 1. The destination is a **single trusted boundary** about to consume both halves immediately (typically a VPS via `scp` or cloud-init `user-data`).
> 2. The user commits to **deleting both files** the moment the destination has imported.
>
> If this is for teammate onboarding, save them to different folders (or different machines) instead.
>
> Continue with same-folder placement?

Wait for explicit confirmation. If different folders, no warning is needed — that's the secure default.

### Pre-flight checks

```bash
# Resolve the canonical repo name vsync will use
cd <repo-path>
git rev-parse --show-toplevel                          # confirm git repo
git config --get remote.origin.url                     # v0.9 resolver input

# Confirm vsync defaults exist (S3 creds will pre-fill init prompts)
[ -f ~/.config/vsync/defaults ] && echo "✓ defaults present" || echo "✗ no defaults — run a normal vsync init somewhere else first"

# Confirm both destination parent dirs exist
mkdir -p "$(dirname <share-dest>)"
mkdir -p "$(dirname <passphrase-dest>)"
```

If `vsync init` has already been run for this `(repo, env)` pair, the next step will print a collision message — that's fine, skip step 1 and go straight to export.

### Command sequence

```bash
# 1. Initialise vsync for this (repo, env). Audit on; skip the .env.<env> migration prompt.
cd <repo-path>
vsync init <env> --audit=on --no-migrate

# 2. Export directly to the chosen .share path. Capture stdout to /tmp so we can
#    grep the passphrase line out. `--no-audit` because operational provisioning
#    isn't a teammate-onboarding event and shouldn't pollute the bucket audit log.
vsync export <env> --out=<share-dest> --no-audit | tee /tmp/_vsync_export.txt

# 3. Extract the passphrase to the chosen path and immediately delete the
#    stdout capture (which still contains the passphrase in plaintext).
grep -E '^\s+passphrase:' /tmp/_vsync_export.txt \
  | sed 's/^[[:space:]]*passphrase:[[:space:]]*//' \
  > <passphrase-dest>
chmod 0600 <passphrase-dest>
rm -f /tmp/_vsync_export.txt

# 4. Verify
ls -la <share-dest> <passphrase-dest>
#    Both should show mode -rw-------
```

vsync writes the `.share` file with mode `0600` automatically. The passphrase file gets `chmod 0600` from the recipe.

### Cleanup checklist — surface AFTER export completes

```bash
# After the recipient (teammate or VPS) confirms `vsync import` + `vsync pull` succeeded:
shred -u <share-dest> <passphrase-dest> 2>/dev/null \
  || rm -P <share-dest> <passphrase-dest>          # macOS/BSD fallback
```

`shred` (Linux) or `rm -P` (macOS/BSD) overwrites the file bytes before unlinking — important on rotational disks and tmpfs.

If the user shared the conversation transcript anywhere (Slack, screen-recording, AI session export), surface that **the passphrase is in the transcript** and they should rotate:

```bash
vsync init <env>             # mints fresh AES key (overwrites the old keychain entry)
vsync push <env>             # re-seal the vault with the new key
# the OLD .share + passphrase now decrypt nothing
```

### What the recipient does

```bash
# On the destination machine, with .share + passphrase file co-located in some
# import directory (typically /tmp/ on a VPS):
bun install -g @muthuishere/vsync@latest
vsync import <env> /path/to/<repo>-<env>.share \
  --passphrase="$(cat /path/to/passphrase.txt)"
vsync pull <env>
vsync use <env>              # if the app reads ./.env

# Immediate cleanup on the destination side
shred -u /path/to/passphrase.txt /path/to/<repo>-<env>.share 2>/dev/null \
  || rm -P /path/to/passphrase.txt /path/to/<repo>-<env>.share
```

### Artefacts the recipe creates / leaves behind

| Artefact | Path | Mode | Action on cleanup |
|---|---|---|---|
| `.share` file | `<share-dest>` | 0600 | `shred -u` or `rm -P` after recipient imports |
| Passphrase file | `<passphrase-dest>` | 0600 | `shred -u` or `rm -P` after recipient imports |
| Local config | `~/.config/vsync/<repo>/env_<env>` | 0600 | **Keep** — source-machine half of the vault |
| Keychain entry | `tools.vsync` / `<repo>/<env>` | OS-keychain | **Keep** — source-machine half of the vault |

---

## How to add a new recipe to this file

The pattern above is the template:

1. **ID + title** as a level-2 heading (`## <PREFIX>-N: <Short title>`). Prefix groups related recipes (`EXPORT-N`, `IMPORT-N`, `ROTATE-N`, etc.).
2. **Trigger phrases** — the natural-language signals that route to this recipe.
3. **Inputs to collect** — what the agent must prompt the user for, separately, before running.
4. **⚠️ Conditional warnings** — surfaced *before* the command sequence runs. Conditions should be computable from the collected inputs (e.g. "if both destinations share a parent folder").
5. **Pre-flight checks** — read-only probes that fail loud if state is wrong.
6. **Command sequence** — copy-pasteable, annotated with WHY each step exists.
7. **Cleanup checklist** — what the user must do after.
8. **What the recipient does** (if the recipe has one) — the receive-side script.
9. **Artefacts table** — every file / config / keychain entry the recipe created, and the cleanup action for each.

Keep recipes opinionated. If a step has two ways to do it, pick one and explain why; don't list both as equivalent.
