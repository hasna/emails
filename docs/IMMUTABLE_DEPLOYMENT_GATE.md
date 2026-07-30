# Immutable deployment gate

This gate is mandatory for any future package release or deployment workflow.
The repository still contains no automatic publishing or deployment workflow;
adding one does not weaken this prerequisite. `bun run deployment:policy` scans
every workflow and fails CI unless each mutating job either runs the gate before
the mutation or normally depends on a job named `immutable-deployment-gate`.
`continue-on-error`, `always()`, late gates, and suppressed gate exits are
rejected.

Run the gate from an exact source checkout after the candidate package has been
published and the candidate image has been pushed by a separately approved
process:

```bash
bun scripts/immutable-deployment-gate.mjs run
```

The runner requires these public bindings:

- `DEPLOYMENT_GATE_CONFIG` — reviewed JSON config described below.
- `DEPLOYMENT_GATE_EVIDENCE` — a new output path. An existing path is refused;
  the output is created mode 0600 without overwrite.
- `DEPLOYMENT_GATE_EXECUTION_ID` — unique workflow run/attempt identity, such as
  `${{ github.run_id }}:${{ github.run_attempt }}`. Evidence cannot be replayed
  under another execution identity.
- `DEPLOYMENT_GATE_CANDIDATE_SHA`, `DEPLOYMENT_GATE_PACKAGE_VERSION`,
  `DEPLOYMENT_GATE_PACKAGE_INTEGRITY`, and
  `DEPLOYMENT_GATE_IMAGE_REFERENCE`.
- The equivalent four `DEPLOYMENT_GATE_ROLLBACK_*` values for the reviewed
  schema-compatible rollback release.

It also requires masked workflow secrets:

- `EMAILS_GATE_API_KEY` — read key for the dedicated synthetic fixture tenant.
- `EMAILS_GATE_OTHER_TENANT_API_KEY` — a valid key for a different tenant.
- `EMAILS_GATE_DATABASE_URL` — source database used for the migration/restore
  drill.
- `EMAILS_GATE_RESTORE_ADMIN_URL` — maintenance connection allowed to create and
  drop only the named isolated restore database.
- `EMAILS_GATE_RESTORE_URL` — connection to that isolated restore database.

The config has this exact shape. Values below are placeholders, not defaults:

```json
{
  "schema_version": 1,
  "candidate": {
    "package_name": "@hasna/emails",
    "package_version": "<exact-version>",
    "package_integrity": "sha512-<registry-integrity>",
    "source_sha": "<40-lowercase-hex>",
    "image_reference": "<repository>@sha256:<64-lowercase-hex>"
  },
  "rollback": {
    "package_name": "@hasna/emails",
    "package_version": "<exact-compatible-version>",
    "package_integrity": "sha512-<registry-integrity>",
    "source_sha": "<40-lowercase-hex>",
    "image_reference": "<repository>@sha256:<64-lowercase-hex>"
  },
  "target": {
    "base_url": "https://<designated-test-endpoint>"
  },
  "database": {
    "restore_database": "emails_deployment_gate_<unique_name>"
  },
  "latency": {
    "max_probe_ms": 5000
  },
  "evidence": {
    "max_age_seconds": 900
  },
  "fixture": {
    "classification": "synthetic_designated_test",
    "production_data": false,
    "message_body_disclosure": false,
    "recipient": "deployment-gate@example.test",
    "search_token": "<unique-opaque-token-at-least-16-characters>",
    "ordered_message_ids": ["<newer-exact-id>", "<older-exact-id>"],
    "content": {
      "message_id": "<newer-exact-id>",
      "field": "text_body",
      "sha256": "<expected-body-sha256>"
    },
    "attachments": [
      {
        "message_id": "<newer-exact-id>",
        "index": 0,
        "filename": "gate-one.txt",
        "sha256": "<expected-attachment-sha256>"
      },
      {
        "message_id": "<older-exact-id>",
        "index": 0,
        "filename": "gate-two.txt",
        "sha256": "<expected-attachment-sha256>"
      }
    ]
  }
}
```

The runner rejects extra config and evidence fields. It verifies registry
metadata for the exact package version, including exact npm `gitHead` and
integrity, then installs both candidate and rollback packages into fresh private
prefixes. It pulls both immutable images and checks their registry digest and
OCI revision/version labels.

The clean-installed candidate CLI must then pass self-hosted status, list,
search, exact read and body hash, offset pagination, cursor-based attachment
inventory, authenticated attachment download and byte hash, unauthenticated
denial, cross-tenant HTTP and CLI denial, and the configured per-probe latency
budget. The process receives an empty HOME plus a poison `EMAILS_DB_PATH`; status
must say `self_hosted`, expose no local data directory, and leave the poison
directory untouched. This makes a silent ambient SQLite fallback a hard failure.

For database compatibility, the gate takes a private custom-format backup,
hashes it, restores it into the dedicated prefixed database, compares aggregate
data and exact migration-ledger fingerprints, applies candidate migrations, and
requires no pending migrations. The clean-installed rollback CLI must accept
that migrated ledger with no pending migration. Finally the original backup is
restored again and both fingerprints must match the source. The temporary dump,
downloaded attachment, clean-install homes, and restore database are removed at
the end. Production backup retention remains a separate cutover requirement.

Evidence contains only immutable package/image bindings, pass/fail check names,
latencies, aggregate fixture counts, and hashes. It never contains API keys,
database URLs, tenant identifiers, message identifiers, subjects, recipients,
message bodies, or attachment bytes. The gate accepts only synthetic designated
messages addressed under the reserved `.test` domain; it cannot be pointed at
ordinary production mail to manufacture body-disclosure evidence.

Immediately before the mutating step, evidence can be rechecked with the same
reviewed environment:

```bash
bun scripts/immutable-deployment-gate.mjs verify
```

Verification rejects stale evidence, another run identity, candidate or rollback
SHA/package/integrity drift, image-digest drift, any missing/skipped check,
latency over budget, disclosure flags, or backup/restore fingerprint drift.
