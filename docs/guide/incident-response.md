# Incident response

A vsync leak almost always falls into one of three shapes. Find the row that matches what leaked; follow the checklist top-to-bottom.

| Leak | Primary action | Then |
|---|---|---|
| Passphrase | [Rotate passphrase](#case-1-passphrase-leaked) | Audit log review, post-mortem |
| IAM key (the bit inside `VSYNC_CONFIG`) | [Rotate IAM key](#case-2-iam-key-leaked) | Bucket-side audit log review |
| Both halves (full process compromise, both env vars in the same log dump) | [Rotate both](#case-3-both-halves-leaked) — and **rotate every upstream secret in the vault** | Treat the vault contents as compromised |

If you're not sure which case you're in, assume **case 3**. It's the most cautious and the work for case 1 or 2 is a subset.

---

## Case 1 — Passphrase leaked

Examples:

- The 4-word passphrase appears in a CI log line.
- A teammate Slack-DM'd it to the wrong channel.
- It's in a screen-share recording.
- It's in an exit-interview transcript.

The vault bundle on S3 is **ciphertext**. The leaked passphrase alone is useless unless the attacker also has `VSYNC_CONFIG` (which contains the bucket location + IAM read key). If both leaked together, jump to **case 3**.

### Checklist

1. **Triage:**
   - [ ] What channel did it leak through? (Slack, CI, ticket, repo, screen recording)
   - [ ] How long ago? (was the audience real-time or after-hours)
   - [ ] Who had access to that channel? (intern with `Slack/Connect`? automated bot logs?)
   - [ ] Is `VSYNC_CONFIG` in the same dump? (if yes → **case 3**, not case 1)

2. **Contain:**
   - [ ] If the leak was a Slack message, **delete** it (acknowledge: this doesn't unspill milk if Slack is being audited, but it caps casual exposure).
   - [ ] If it was a CI log: rotate logs and revoke any retained build artifacts that include the value.
   - [ ] Note the timestamp of the leak. You'll want this for the audit-log review.

3. **Rotate the passphrase** — follow the [Rotate-passphrase runbook](/guide/rotate-passphrase-runbook). Pass `--note="incident #<ticket>"` so the rotate row in `audit.csv` is annotated.

4. **Audit log review** — after rotation, check what bundle access happened *before* the leak:
   ```bash
   vsync audit prod --all > audit.csv
   ```
   Look for:
   - [ ] `pull` rows from unexpected `hostname` / `local_ip` / `git_email`.
   - [ ] Unusually high `pull` cadence (someone scripting fetches).
   - [ ] Rows from IPs you don't recognise.
   - Remember: vsync's audit log is **not tamper-evident**. A bad actor with bucket-write could have rewritten it. Cross-check with bucket-side access logs ([AWS S3 server access logs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ServerLogs.html) / Hetzner / R2 equivalents).

5. **Notify:**
   - [ ] Open / update the incident ticket. Link the audit log row for the rotation.
   - [ ] Post in your team's ops channel: "passphrase for prod env rotated due to <reason>, gen X → X+1, race window closed at <time>".
   - [ ] If customer data is implicated, follow your org's customer-notification policy.

6. **Post-mortem:**
   - [ ] How did the passphrase end up in the leaky channel? Were observability tools (Sentry, Datadog, Honeycomb) capturing `process.env` automatically? Add filters.
   - [ ] Was the CI log retention longer than necessary?
   - [ ] Update the [observability hygiene](/architecture/security#what-vsync-cant-protect-against) checklist for your team.

---

## Case 2 — IAM key leaked

Examples:

- A `VSYNC_CONFIG` blob appears in a public Terraform module on GitHub.
- A teammate pastes it into a ticket / Slack thread.
- The platform secret store's audit log shows external API access from an unexpected IP.

The IAM key in `VSYNC_CONFIG` is **read-only** and **bucket-prefix-scoped** if you followed the [IAM policy template](/guide/iam-rotation-runbook#1-cloud-admin-issues-the-new-iam-key). With it, an attacker can fetch the encrypted bundle from S3 — but they need the passphrase to decrypt it. If they have both, jump to **case 3**.

### Checklist

1. **Triage:**
   - [ ] Confirm the leaked blob is actually `vsync-cfg-v1:…` (not a different secret).
   - [ ] Decode it locally to confirm which `(repo, env)` it's for and which bucket/prefix:
     ```bash
     echo 'vsync-cfg-v1:...' | sed 's/^vsync-cfg-v1://' | base64 --decode | gunzip | jq .
     ```
   - [ ] Is the passphrase also in the same dump? (if yes → **case 3**)

2. **Contain:**
   - [ ] Delete the leaked blob from wherever you can (Slack edit, ticket update, Git history rewrite if in a repo).
   - [ ] If the blob is in a public repo, **rotate first, redact second.** The IAM key is already public.

3. **Rotate the IAM key** — follow the [IAM rotation runbook](/guide/iam-rotation-runbook). Don't skip step 6 (deactivate then delete the old key).

4. **Bucket-side audit:**
   - [ ] Pull S3 server access logs for the affected prefix:
     ```bash
     aws s3api list-objects-v2 --bucket your-bucket --prefix logs/  # adjust to your logging config
     ```
   - [ ] Filter for `GetObject` / `ListBucket` operations using the leaked `AccessKeyId` from before the rotation timestamp.
   - [ ] Any unexpected source IPs → record them in the incident ticket.
   - [ ] Cross-reference with the vsync audit log (`audit.csv`). If something is in the bucket log but not `audit.csv`, that's worth a flag — either someone bypassed `vsync pull` (used `aws s3 cp` directly) or the audit-write happened to fail.

5. **Notify** — same as case 1.

6. **Post-mortem:**
   - [ ] How did the blob end up in the leaky channel? Was it pasted into a comment, committed to infra-as-code, exfiltrated by a malicious dep?
   - [ ] Is the IAM policy actually scoped to this one prefix? Run `aws iam get-user-policy --user-name vsync-prod-reader --policy-name <name>` and verify.
   - [ ] Consider whether per-teammate IAM keys are warranted — vsync's audit log captures git-email, but the bucket-side log only sees the IAM key. Splitting keys per teammate makes the bucket-side log directly attributable.

---

## Case 3 — Both halves leaked

Examples:

- A CI runner dumped all env vars (including both `VSYNC_CONFIG` and `VSYNC_PASSPHRASE`) into a public log.
- Sentry's `process.env` auto-capture sent both to a third-party observability vendor.
- A laptop with both halves in the keychain was stolen and is unlocked.
- A process compromise dumped `/proc/<pid>/environ`.

The vault is **decryptable.** Anything in the vault — DB passwords, third-party API keys, signing keys, certs — should be treated as **compromised**, not just rotated within vsync.

### Checklist

1. **Triage — fast:**
   - [ ] When did the leak happen? (timestamp window for the audit log)
   - [ ] What's in `infra/vault/<env>/`? List every secret that needs upstream rotation.
   - [ ] Is the leak audience known (one internal channel) or open (public log, vendor breach)?

2. **Rotate the passphrase** — [Rotate-passphrase runbook](/guide/rotate-passphrase-runbook).
   - [ ] Note: this only protects **future** access. Anyone who already grabbed the old bundle has the old plaintext.

3. **Rotate the IAM key** — [IAM rotation runbook](/guide/iam-rotation-runbook).
   - [ ] Same caveat: future S3 fetches are blocked; past fetches already happened.

4. **Rotate every upstream secret** — this is the load-bearing step for case 3. The vault contents were plaintext-accessible. For each entry:
   - [ ] **`DATABASE_URL` / DB passwords** — `ALTER USER … WITH PASSWORD …`, push the new URL, restart apps.
   - [ ] **Third-party API keys** (Stripe, SendGrid, OpenAI, …) — revoke in the vendor dashboard, issue new, push.
   - [ ] **OAuth client secrets** — rotate in the OAuth provider, push.
   - [ ] **JWT / session signing keys** — push a new key; this invalidates all existing sessions (acceptable in a leak scenario).
   - [ ] **TLS certs** if private keys were in the vault — re-issue (Let's Encrypt + force-renew, or your CA).
   - [ ] **GCP / AWS service-account keys** — delete in IAM, issue new, push.
   - [ ] **SSH keys** if any were in the vault — rotate the keypair, update authorized_keys on relevant hosts.

5. **Push** the rotated values into the vault:
   ```bash
   # Edit infra/vault/<env>/.env.<env> and friends, then:
   vsync push <env> --note="rotation after incident #<ticket>"
   ```

6. **Fanout** to downstream secret stores so they update too:
   ```bash
   vsync sync <env> gh        # if used
   vsync sync <env> gcp       # if used
   vsync sync <env> aws       # if used
   # etc — one per backend that's downstream
   ```

7. **Notify:**
   - [ ] Internal: ops channel + incident ticket as before.
   - [ ] Vendor: notify any third-party whose key was in the vault (Stripe, SendGrid auto-revoke if you tell them).
   - [ ] Customers: follow your org's notification policy. If customer-impacting secrets (DB password protecting customer data) were in scope, this likely triggers GDPR / SOC2 / similar disclosure obligations.

8. **Audit:**
   - [ ] Bucket-side: who fetched bundles in the window between leak and rotation?
   - [ ] vsync audit log: same window.
   - [ ] Upstream services: any unusual activity on the rotated keys before they were rotated? (Stripe webhook events from unknown IPs, DB query patterns, GCP audit logs.)

9. **Post-mortem:**
   - [ ] How were both halves in the same dump? Almost always: a process exposed `process.env` to a third party. Identify the leak channel and add filters / suppression rules.
   - [ ] Was the observability tool's "auto-capture env on crash" the culprit? Configure to redact `VSYNC_*` keys.
   - [ ] Was a CI step doing `env | curl …`? Replace with explicit allowlist.
   - [ ] Update onboarding docs for new engineers — these rules are easy to forget.

---

## Useful artifacts during incident response

### Decoding a leaked `VSYNC_CONFIG` blob

```bash
echo 'vsync-cfg-v1:H4sIAAAA...' \
  | sed 's/^vsync-cfg-v1://' \
  | base64 --decode \
  | gunzip \
  | jq '{endpoint, region, bucket, prefix, env}'
# Shows what was exposed without printing the IAM secret to a script's logs.
```

### Listing audit rows in a time window

```bash
vsync audit prod --csv \
  | mlr --c2t --headerless-csv-output filter '$ts >= "2026-05-22T10:00:00Z" && $ts <= "2026-05-23T14:00:00Z"'
# Substitute mlr / jq / awk per your toolchain.
```

### Bucket-side access logs

```bash
# AWS S3 server access logs (if configured)
aws s3 cp s3://your-logging-bucket/your-app-logs/2026-05-22/ . --recursive
# Then grep / awk for the leaked AccessKeyId.
```

### Confirming new gen is everywhere

```bash
# Run from a laptop with the env initialized:
vsync status --check-remote

# Run against each app instance:
for host in app1 app2 app3; do
  echo "$host: $(curl -s https://$host.internal/healthz | jq -r .gen)"
done
```

---

## What vsync deliberately does NOT do

- **No remote kill switch.** vsync cannot reach into a teammate's laptop and erase their pulled vault contents. Once they `pull`-ed, they have a local copy. Offboarding requires upstream secret rotation, not vsync magic.
- **No automatic incident detection.** The audit log is a transparency aid; it doesn't alert you. Wire `vsync audit prod --csv` into your SIEM if you need alerting.
- **No "freeze the bucket" verb.** If you need to lock down access, do it at the cloud-provider IAM layer (deny everyone, then re-grant after rotation).

These are deliberate scope choices. See [security model](/architecture/security) for the boundaries.

## Where to go next

- **Rotate the passphrase:** [Rotate-passphrase runbook](/guide/rotate-passphrase-runbook)
- **Rotate the IAM key:** [IAM rotation runbook](/guide/iam-rotation-runbook)
- **First-time setup checklist:** [First team setup](/guide/first-team-setup)
- **What we protect against (and don't):** [Security model](/architecture/security)
