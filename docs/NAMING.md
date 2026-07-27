# Naming: this product is open-emails, not Mailery

Status: binding. Owner ruling by Andrei Hasna, 2026-07-27.

## The ruling

The owner's verbatim wording is recorded in the Knowledge entry
`k_ms2x7nlw_ek0nrh` (tag `convention`), not quoted here: it uses the commercial
vocabulary that this package's own boundary guard bans from every tracked file
(`scripts/no-cloud-scan-lib.mjs`, "hosted implementation vocabulary"). Quoting
it verbatim in this file would turn CI red. That is the guard working, not a
problem to route around.

In substance: Mailery is retired as a brand name for this product, which is
renamed to open-emails; Mailery becomes a different, unrelated commercial
product.

Stated as rules:

1. The OSS email core is **open-emails**. It is the repository
   `hasna/emails`, the npm package `@hasna/emails`, and the `emails`,
   `emails-mcp`, and `emails-serve` bins.
2. **`@hasna/mailery` is a legacy package name.** It is the abandoned 0.6.x
   line (0.6.20-0.6.116, last published 2026-07-08). It is not this package
   and must never be revived by publishing this tree under that name.
3. **Mailery is reserved for a separate, unrelated future commercial product**
   and **must not be used to refer to the email product** — not in docs, not in
   code, not in commit messages, not in issue titles, not in conversation.

`open-emails` is the product/brand name. It does not change the repository or
package name: per the org-wide OSS naming convention the GitHub repo is
`hasna/<name>` and the npm package is `@hasna/<name>` with no `open-` prefix,
while `open-<name>` is the brand and the local workspace folder name. So
`open-emails` -> `hasna/emails` -> `@hasna/emails` is already correct and
consistent, and nothing about this ruling requires renaming either.

## What this ruling does NOT ask you to do

The rename it describes has already happened. It landed on 2026-07-11 in PR #21
(`chore/rename-back-to-emails`, commits `8eac4ed` and `c19bf70`). Since then
this package publishes as `@hasna/emails` and ships only `emails*` bins.

The word "mailery" still appears in this tree, and **almost all of those
occurrences must stay**. They fall into three groups, none of which is
branding:

### 1. Guards that enforce this ruling (the large majority)

`src/package-identity.test.ts` pins the package name, repository URL, and bin
list, and asserts CI checks them. `src/no-cloud-boundary.test.ts` plus
`scripts/no-cloud-scan-lib.mjs` scan every tracked file for banned cloud and
Mailery patterns. `src/lib/mode.test.ts` proves the banned env selectors are
rejected.

These files contain the string "mailery" **because their job is to keep it
out**. Deleting the word from them deletes the enforcement. A "clean up all
mailery references" pass over this repo would silently disarm the mechanism
that makes the ruling true.

### 2. Compatibility with production state that already exists

Renaming any of these breaks deployed systems, so they are frozen:

| Reference | Where | What breaks if renamed |
| --- | --- | --- |
| Migration IDs `0001_mailery_selfhosted_core` .. `0005_mailery_selfhosted_resources` | `src/server/self-hosted/migrations.ts` | Migration IDs are immutable ledger entries. Renaming them makes deployed databases re-run applied migrations. |
| API key alias slug `"mailery"` | `hasna.contract.json` (`apiKeyAppAliases`), `src/server/self-hosted/{keys,api-key-verifier,serve}.ts` | API keys already minted under the `mailery` slug stop verifying — this revokes live credentials. |
| `legacy-inbound@local.mailery` | `src/db/database.ts` | A retired synthetic inbound identity present in deployed SQLite databases. Renaming orphans real rows. |
| `LEGACY_MAILERY_EVENT_SOURCE` / `mailery.v1` | `src/lib/emails-events.ts` | Wire compatibility for events emitted by older versions. |
| `mailery_mode` config key migration | `src/lib/config.ts` | The forward-migration path for existing on-disk config. |

### 3. Rejected input, deliberately named

`MAILERY_*` and `HASNA_MAILERY_*` environment variables are **banned
selectors**, not aliases — `src/lib/mode.ts` and
`src/server/self-hosted/env.ts` reject them loudly rather than honoring them.
The canonical prefix is `EMAILS_*`. The names must remain listed in order to be
refused with a useful error.

## Mailery is a different product

`hasnatools/platform-mailery` (private, `mailery.co`) and `hasnatools/mailery`
(public, issues-only) belong to that separate product, and they keep the name.
That separation is already enforced from both sides: `platform-mailery`'s
commercial contract lists `@hasna/emails` as a non-dependency with a test
asserting it is absent, and this repo stays cloud-free with the `mailery*` bin
names deliberately left free for that product's CLI.

The practical consequence for this repo: **`@hasna/emails` has no hosted
counterpart.** Its two deployment modes are `local` and `self_hosted`, both
operator-owned. Do not describe `mailery.co` as the hosted version of this
package, and do not add a client for it here.

## If you are an agent about to "fix" a naming inconsistency here

Read this file first, then check whether the string you are about to change is
a guard, a compatibility constant, or a banned-input name. If it is any of the
three, leave it alone. Genuine residue is tracked separately; renaming a
published package, a repository, or a deployed resource requires explicit owner
approval for that specific step.
