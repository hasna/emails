# Retiring station-local Emails state

This runbook is the coordinated gate for retiring local SQLite state from two
client stations after migration to an operator-owned Emails service. It is not
evidence that a station has already been retired. Store all evidence outside the
repository in an access-controlled case directory; database, attachment, cache,
and backup manifests can reveal private paths and mailbox metadata.

The operation is fail-closed. Do not stop a writer until both stations have
passed the same published smoke and both pre-stop backups have been independently
restore-verified. Do not quarantine either station until both stations have also
passed the stopped-writer recheck. Never delete or shorten the retention of a
backup during this procedure.

## Evidence contract

Create one sealed evidence bundle per station. The two station identifiers must
be distinct, and both bundles must name the same service tenant, release commit,
and SHA-256 of `scripts/self-hosted-client-smoke.sh`. Each bundle records:

- the station identifier, executor, timestamps, release commit, and service
  tenant identifier (never a token or database credential);
- the aggregate JSON emitted by `./scripts/self-hosted-client-smoke.sh`, with a
  zero exit status, plus the smoke-script SHA-256;
- a canonical source manifest with an explicit row for the SQLite database and
  each `-wal`, `-shm`, and `-journal` sidecar, recording `MISSING` when a sidecar
  does not exist, and a recursive file/size/SHA-256 manifest for every local
  attachment or cache root;
- deterministic local row counts and the reviewed, semantically comparable
  remote counts used for parity. Record the exact query/CLI command and schema
  version beside every count; local and Postgres table names are not themselves
  proof of semantic parity;
- a backup manifest, its checksum, restore location, restore-test result,
  SQLite `PRAGMA integrity_check` result, and restored row counts;
- the independent backup verifier's identity and timestamp. The verifier must
  not be that station's retirement executor;
- the quarantine path, rollback owner, retention owner, UTC retain-until time,
  and the ticket or policy that authorizes any later retention decision.

The state manifest is authoritative, not the default path. The usual database
is `~/.hasna/emails/emails.db` and usual downloaded attachments are below
`~/.hasna/emails/attachments`, but `HASNA_EMAILS_DB_PATH`, `EMAILS_DB_PATH`, and
`inbound_emails.attachment_paths` can name other locations. Discover those
locations before the gate. Reject symlinks, non-regular database artifacts,
relative paths, duplicate destinations, and a quarantine nested under any active
state path. Keep client configuration and credentials out of the state move.

## 1. Two-station pre-stop barrier

On each station, with both database-path variables **unset**, set the canonical
self-hosted client environment and run the exact script from the reviewed
release:

```bash
test "${HASNA_EMAILS_DB_PATH+x}" != x
test "${EMAILS_DB_PATH+x}" != x
test -n "${EMAILS_CLIENT_ENV_SECRET:-}" || test -n "${EMAILS_SELF_HOSTED_URL:-}"
./scripts/self-hosted-client-smoke.sh >"$PRIVATE_EVIDENCE_DIR/pre-stop-smoke.json"
```

Independently restore and inspect each pre-stop backup. Compare its checksum,
integrity result, database counts, attachment/cache file count, byte count, and
content manifest with the bundle. A successful copy command is not a restore
test. The coordinator signs a two-station barrier only after both smoke records
and both independent backup reviews pass. A failure or missing bundle stops the
operation on both stations.

## 2. Stop and fence every local writer

Inventory and stop the station's actual processes: daemon or launch service,
SMTP listener, webhook server, MCP process, scheduler, sync job, TUI auto-pull,
cron job, and any long-running CLI. The inventory is site-specific; a process
name alone is not proof. Record service-manager state and prove no process has
the database, WAL, SHM, journal, attachment roots, or cache roots open.

Do this on both stations before either state move. Do not run a local-mode Emails
command after the fence: resolving the default local store can create
`~/.hasna/emails/emails.db` and invalidate the evidence.

## 3. Recheck stopped state and final backups

While every writer remains stopped:

1. Rebuild the canonical source manifest twice and require identical path,
   type, size, and SHA-256 records. Explicitly recheck the database, `-wal`,
   `-shm`, and `-journal` states even when they are absent.
2. Copy the exact database and existing sidecars to a private validation
   directory. Run integrity and deterministic count queries against that copy,
   not the fenced source, then prove a third source manifest is unchanged.
3. Recompute the attachment/cache file count, byte count, and per-file hashes.
   Compare them to the stopped-state manifest and the parity evidence.
4. Produce a final fenced backup and have the independent verifier restore it,
   rerun integrity/count checks, and compare its attachment/cache manifest.

Seal the final source manifest, counts, final-backup manifest, verifier record,
and an exact source-to-quarantine move plan. If a source changes, a count differs,
integrity is not `ok`, a backup cannot be restored, or either station lacks its
final verifier record, do not move state on either station.

## 4. Move exact state to recoverable quarantine

The reviewed quarantine must be private, outside every active Emails path, on
the same filesystem as each source so each move is a rename rather than an
unverified copy-and-remove. It must not exist at a path the runtime scans or
creates. Create it with mode `0700`; its files retain mode `0600` or stricter.

Execute only the sealed source-to-destination plan. Move the database, every
sidecar whose manifest state is present, and each exact attachment/cache root.
Never glob and never move the whole `~/.hasna/emails` directory: it can contain
the client configuration needed for remote operation. Refuse an existing
destination. Record every successful rename, then generate a quarantine
manifest with paths normalized back to their original source names and require
it to equal the final source manifest byte-for-byte.

Write these non-secret controls beside the quarantine manifest:

- `original-paths.tsv` (exact rollback mapping);
- `retention-owner` and `retain-until`;
- `rollback-owner` and the approval ticket;
- checksums of both station evidence bundles and the final backup manifests.

The independently verified backups remain in their protected backup locations.
Do not move, replace, prune, or delete them as part of quarantine.

## 5. Remote proof and non-recreation proof

On both stations, keep local writers disabled and local database variables
unset. Run the same published smoke again, followed by any station-specific
read-only workflows in the parity record. Preserve their aggregate results.

Before and after those commands, require that every original database/sidecar
and attachment/cache source in the move plan is absent. Recheck after the normal
client service/MCP startup interval as well; a one-shot check does not catch a
scheduled writer. Require the quarantine manifest and hashes to remain
unchanged. Any recreated database, WAL, SHM, journal, attachment directory, or
cache path is a failed retirement: stop the recreating process and return to the
stopped-state gate.

The operation is complete only when both post-move smoke records pass, both
stations still have no active local state, both quarantine manifests match, and
the coordinator signs the joint result.

## Rollback

Rollback requires the named rollback owner and a new approval; one station must
not silently diverge from the other. Stop all Emails clients and writers, verify
the quarantine and protected-backup checksums, and require every original target
path to be absent. Restore a copy of each quarantined item to the exact path in
`original-paths.tsv`, preserving ownership and modes, then compare the restored
manifest, integrity result, and counts with the sealed final evidence before
enabling any local writer. If quarantine validation fails, restore from the
independently restore-tested final backup instead. A rollback consumes neither
backup and does not authorize backup deletion.

Record which store is authoritative before restarting. Never configure an
Emails API and a local database path in the same process: the client deliberately
refuses that ambiguous two-store configuration.

## Retention handoff

The retention owner acknowledges custody of both protected backup sets,
quarantines, manifests, and rollback instructions. Retention extends through the
latest rollback, legal, incident-response, or operator-policy deadline. Expiry
only creates a review; it is not an automatic deletion instruction. Any later
destruction is a separate approved operation outside this goal. Cutover success
is never authority to delete a backup.
