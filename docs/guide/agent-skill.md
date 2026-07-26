# Using vsync with an AI assistant

vsync ships an **agent skill** — a small instruction bundle that teaches an
LLM assistant (Claude Code, or anything that reads skill files) how to walk
you through vsync without inventing commands.

It lives at [`skills/vsync/`](https://github.com/muthuishere/vsync/tree/main/skills/vsync)
in the repo.

## What it is, and what it deliberately isn't

The skill is a **trigger + workflow + reference bundle**. Its whole job is to
shorten the path from *"I just heard about vsync"* to *"my first push landed
and my teammate's first pull worked."*

It does **not** reimplement the CLI. Every operation is *show the command,
explain it in one sentence, run it after you confirm*. When you ask something
it doesn't cover, it points at `vsync <sub> --help` or this site rather than
inventing an answer — the CLI is the engine, the skill is the friction
remover, and this site is the manual.

It's four files and under 500 lines on purpose:

```
skills/vsync/
├── SKILL.md                      what vsync is · 5 workflows · 5 rules · worktrees
└── references/
    ├── workflows.md              the command sequences, in detail
    ├── troubleshooting.md        the common failures and how status diagnoses them
    └── decision-points.md        the branch points, one question each
```

## Install it into Claude Code

Copy the bundle into your skills directory:

```bash
git clone https://github.com/muthuishere/vsync /tmp/vsync
mkdir -p ~/.claude/skills
cp -r /tmp/vsync/skills/vsync ~/.claude/skills/vsync
```

Or, if vsync is already a dependency of the repo you're working in, point at
its copy — skills can live in the project too.

Then just describe what you want:

> "I want to share secrets with my team"
> "onboard my teammate, I've got her a share file"
> "something's broken, vsync says the key doesn't match"

The skill triggers on intent, not on you naming the tool.

## What it will and won't do for you

**It will:**

- pick the right workflow (first-time setup / onboarding / daily / runtime /
  something broke) and walk it one command at a time
- ask the one decision that matters at each branch — which S3 backend, owner
  or joining, where your `.share` file landed
- diagnose which of the [two halves](/guide/troubleshooting) is missing when
  something fails, before suggesting a fix

**It won't:**

- install vsync for you. If it's not on `PATH` it surfaces the install command
  and stops.
- paste a passphrase or share-file contents into the chat transcript. It works
  on filenames and asks you to type secrets locally.
- let you send a `.share` file and its passphrase on the same channel without
  telling you that defeats the threat model.
- pretend per-user revoke exists. It will tell you honestly that offboarding
  means [rotate + re-export](/guide/rotate-passphrase-runbook).

## Two honest limits it's told to state

The skill is instructed to be straight with you about these rather than
working around them:

1. **Passphrases aren't stored anywhere.** `vsync export` prints one once. Lose
   it and the share file is dead — export again.
2. **Partial sharing works per environment, not per secret.** One AES key
   covers a whole env, so `vsync keystore export --repo=… --env=…` can hand
   over one environment but not three keys out of forty inside it.

## Writing your own

The design contract is
[`docs/specs/v0.14-agent-skill.md`](/specs/v0.14-agent-skill) — worth reading
if you're adapting the skill for another assistant. The short version: keep it
under 600 lines, keep the trigger list to six or ten representative phrases
rather than an SEO wall, and route everything else to `--help` and this site.

---

[Command reference →](/guide/commands) · [Troubleshooting →](/guide/troubleshooting)
