// CLI capability guide emitted by `vsync docs` (no argument).
//
// "What vsync does and how to drive it" — a command map plus pointers to the
// provider runbooks (`vsync docs aws|gcp|custom`), the agent map
// (`vsync docs agent`), and per-subcommand `--help`. Shipped as a string so
// it stays in sync with the verb set and works offline.

export const DOCS_OVERVIEW = `# vsync — what it does & how

vsync syncs an encrypted vault folder (\`.env\` files, JSON keys, certs)
between teammates via any S3-compatible bucket. A per-machine AES key lives
in the OS keychain (service \`tools.vsync\`); the bucket alone is useless
without it. Full manual: https://muthuishere.github.io/vsync/

## Commands

profiles (named S3 credentials — once per machine)
  profile add <name>            create a profile: endpoint, region, bucket, access/secret key
  profile list                  list saved profiles (name, endpoint, bucket)
  profile show <name>           show one profile (secret masked unless --reveal-secret)
  profile remove <name>         delete a profile

setup
  init <env> --profile=<name>   bind a (repo, env): generate AES key + write config

daily
  push <env>                    encrypt + upload the vault to s3://<bucket>/<repo>/<env>/
  pull <env>                    download + decrypt + unpack the vault
  use <env>                     symlink ./.env → infra/vault/<env>/.env.<env>
  versions <env>                list encrypted versions on the bucket (read-only)
  audit <env>                   append-only log: who pushed/pulled/exported, when

teammates
  export <env>                  write a passphrase-encrypted .share file to onboard someone
  import <env> <share-file>     install a .share file into local config + keychain

deployment
  sync <env> <target>           fan out the vault's KVs to a secret store
                                targets: gh | gcp | aws | azure | vault
  runtime-token --env=<env>     mint the VSYNC_CONFIG blob for runtime libraries

rotation / info
  rotate-passphrase --env=<env> re-encrypt the bundle under a new passphrase
  status                        local configs, profiles, and orphans (offline)

Every (repo, env) needs BOTH halves: a config file under \`~/.config/vsync/\`
AND a key in the OS keychain. Missing either → push/pull fail with a
next-step message.

## How do I…

  set up a bucket?              vsync docs aws | gcp | custom
  drive vsync as an AI agent?   vsync docs agent
  see every flag + example?     vsync <sub> --help
  read the full manual?         https://muthuishere.github.io/vsync/
`;
