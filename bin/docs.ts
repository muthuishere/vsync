#!/usr/bin/env bun
// Usage: vsync docs [<topic>]
//
// No argument → the CLI capability guide (what vsync does + how to drive it).
// A <topic> → a provider bucket-setup runbook (aws | gcp | custom) or the
// agent workflow map (agent). `list` prints the available topics.
//
// All content is shipped inside the binary (src/templates/docs.md.ts +
// src/templates/handbook.ts), so it works offline and stays in sync with the
// verb set. No prompts.

import { parseArgs } from "../src/argv";
import { wantsHelp, printHelp } from "../src/help";
import { DOCS_OVERVIEW } from "../src/templates/docs.md";
import { resolveTopic, renderTopicList } from "../src/templates/handbook";

const HELP = `
NAME
  vsync docs — print what the CLI does (or a setup / agent runbook)

SYNOPSIS
  vsync docs                 CLI capability guide (what vsync does + how)
  vsync docs <topic>         provider bucket-setup runbook, or the agent map
  vsync docs list            list the available runbooks

DESCRIPTION
  With no argument, prints a CLI capability guide: a command map (what each
  verb does) plus pointers to the provider runbooks, the agent map, and
  per-subcommand \`--help\`. This documents the CLI itself — it is NOT a
  repo file to commit.

  With a <topic>, prints a complete, copy-paste runbook: for a provider,
  how to create the bucket + credentials then profile / init / push / pull
  / use / sync / dev-onboarding; for \`agent\`, the intent→command workflow
  map an assistant follows to drive vsync.

  All content is shipped inside the binary — no network call, no separate
  install, no prompts.

TOPICS
  aws        Bucket on AWS S3 (aws s3api + IAM key)
  gcp        Bucket on Google Cloud Storage (gcloud + HMAC interop key)
  custom     Bucket on your own S3 / VPS (MinIO, R2, B2, Wasabi, Hetzner, Spaces)
             (aliases: awss3 | gcps3 | vps | minio | r2 | …)
  agent      Agent / LLM workflow map — which command to run for each intent
             (aliases: agents | skill | ai | llm)

FLAGS
  --help, -h               print this help and exit

EXAMPLES
  vsync docs                          # what vsync does + how to drive it
  vsync docs aws                      # AWS S3 bucket setup runbook
  vsync docs gcp | less              # GCS runbook through a pager
  vsync docs agent                    # workflow map for AI agents / assistants
  vsync docs list                     # what runbooks exist

EXIT CODES
  0    content printed successfully
  1    unknown topic (the topic list is printed to stderr)

SEE ALSO
  vsync init(1)            the command the runbooks walk you through
  README.md                project-level overview
`;

export async function main(argv: string[]): Promise<void> {
  if (wantsHelp(argv)) printHelp(HELP);

  const { positional } = parseArgs(argv);
  const topicArg = positional[0];

  // No topic → the CLI capability guide.
  if (!topicArg) {
    process.stdout.write(DOCS_OVERVIEW);
    return;
  }

  if (topicArg === "list" || topicArg === "topics") {
    process.stdout.write(renderTopicList() + "\n");
    return;
  }

  const topic = resolveTopic(topicArg);
  if (!topic) {
    console.error(`unknown docs topic: "${topicArg}"`);
    console.error("");
    console.error(renderTopicList());
    process.exit(1);
  }

  process.stdout.write(topic.body);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
