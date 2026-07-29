# Provider credential storage

Local provider credentials are envelope-encrypted. Ordinary `providers` rows
retain their historical credential columns only so older databases can be
migrated; current rows keep every one of those columns `NULL`. Ciphertext,
nonces, authentication tags and wrapped per-provider data keys live in
`provider_secrets`. The AES-256-GCM root keys never enter SQLite.

By default the root-key keyring is
`~/.hasna/secrets/open-emails-provider-credentials.keyring.json` (mode `0600`,
inside a mode `0700` directory). Operators may instead bind a separately
protected keyring with `EMAILS_PROVIDER_SECRETS_KEY_FILE`, or inject one
base64/hex 32-byte recovery key with `EMAILS_PROVIDER_SECRETS_KEY`. Inline keys
cannot be rotated by the CLI and should be supplied by an OS keyring or secret
manager, not committed to an environment file.

On first open, legacy plaintext values are encrypted and cleared in one SQLite
savepoint. Secure deletion, compaction and WAL truncation remove the superseded
bytes before a post-migration database backup is safe. SQLite triggers reject
later attempts to put credentials back into ordinary provider rows.

The local execution boundary unwraps a credential only when constructing a
provider adapter. Provider list/get DTOs, REST/MCP responses, exports and generic
resources expose metadata only. Error messages identify a provider or root-key
ID, never a credential, ciphertext plaintext, or command argument.

## Rotation and recovery

Use:

```bash
emails provider secrets status
emails provider secrets rotate-root
emails provider secrets rewrap
emails provider secrets revoke-root <old-key-id> --yes
```

Rotation stages the new root in the external keyring, atomically rewraps every
data key, and only then makes the new root active. The old root remains for
in-flight work and crash recovery until explicit revocation. Revocation fails
while any envelope still references the key.

A database backup is intentionally insufficient on its own. Back up the
keyring separately under the protection used for other root credentials. To
restore on another machine, restore the database, bind the original keyring
with `EMAILS_PROVIDER_SECRETS_KEY_FILE`, verify `provider secrets status`, then
optionally rotate and revoke the transported root. Opening a database with
encrypted provider rows and no matching root key fails closed; it does not
generate a replacement or attempt a send.

Self-hosted operation does not store provider credentials in tenant provider
rows. The service sender uses operator-injected secret-manager values or its
least-privilege workload role. Provider resources remain tenant-scoped metadata,
and clients never retrieve service credentials.

## Threat model and review checklist

Protected: SQLite files, WAL/journal files, ordinary database backups, public
DTOs, diagnostics, logs and exports. Compromise of both the database and the
external root-key keyring is outside this boundary; rotate upstream provider
credentials and the root key after such a compromise. A process already
authorized to send necessarily sees a credential briefly in memory.

Independent review should verify the migration savepoint and raw-byte purge,
AES-GCM AAD binding (`provider id`, `revision`, and purpose), root-key separation,
locked-keyring failure paths, DTO projections, rotation crash points, restore
rebind instructions, and tenant isolation in the self-hosted store. This
document records the review surface; it is not itself an independent sign-off.
