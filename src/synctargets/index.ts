// HANDLERS registry — see docs/specs/v0.8-multi-target-sync.md §2.2.

import { ghHandler } from "./gh";
import { gcpHandler } from "./gcp";
import { awsHandler } from "./aws";
import { azureHandler } from "./azure";
import { vaultHandler } from "./vault";

export const HANDLERS = {
  gh: ghHandler,
  gcp: gcpHandler,
  aws: awsHandler,
  azure: azureHandler,
  vault: vaultHandler,
} as const;

export type TargetName = keyof typeof HANDLERS;

export type { TargetHandler, ResolveResult, RunSyncOpts } from "./types";
