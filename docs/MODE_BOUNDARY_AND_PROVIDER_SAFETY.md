# Mailery Mode Boundary And Provider Safety

Date: 2026-07-06

Canonical source path: `/home/hasna/workspace/hasna/opensource/open-mailery`

Canonical GitHub repo: `hasna/mailery`

Package: `@hasna/mailery`

`open-emails` is compatibility-only during the rename period. The older
`/home/hasna/Workspace/hasna/opensource/open-mailery` checkout is a stale
duplicate for new implementation work.

## Deployment Modes

Mailery uses the canonical deployment terms:

| Deployment mode | Meaning | Source of truth |
| --- | --- | --- |
| `local` | This machine or a dev/fleet box. | Local SQLite/files. |
| `self-hosted` | Hasna-owned AWS deployment for internal Mailery service operation. | Hasna-owned RDS/S3/provider state behind `mailery-serve`. |
| `cloud` | Managed Mailery SaaS for external users. | Mailery Cloud hosted API/control plane. |

The current public client runtime has two values: `local` and `cloud`.
Self-hosted deployments use the Hasna-owned AWS service/API path and client API
URL, not local SQLite as a shared source of truth. Deprecated `self_hosted`,
`remote`, and `hybrid` values are accepted only as compatibility aliases and
must not be used as new deployment-mode vocabulary.

## Provider Modes

Provider adapters must be described as one of:

- `mock`
- `fixture`
- `sandbox`
- `read_only_live`
- `live_mutating`

Live mutation is blocked unless the operation has capability evidence, required
credential refs or leases, operator approval, idempotency, sandbox/no-side-effect
proof, rollback or revocation instructions, and reconciliation evidence.

## Required Smokes

- No-send: `mailery send --dry-run` must print `[NOT SENT]`, avoid provider
  adapters, and avoid sent-ledger writes.
- No-domain-change: domain/provisioning commands must expose `--dry-run` plans
  and preserve existing MX unless the operator explicitly passes
  `--force-mx-switch` or cloud MX migration consent.
- Signed webhook: Resend webhooks require valid Svix headers when a secret is
  configured and replayed `svix-id` values are rejected.
- Cloud/local boundary: local provider send is disabled in `cloud` mode; cloud
  sends go through the API client path.

The SDK surface for this matrix is `maileryProviderSafetyMatrix()`.
