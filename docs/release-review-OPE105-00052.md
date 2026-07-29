# OPE105-00052 release-closure review

Review date: 2026-07-29 UTC

Decision: **BLOCKED — P1 findings remain.**

P0 findings: none demonstrated.

This is a point-in-time, read-only review. It does not authorize a package
publish, AWS mutation, email send, super-admin bootstrap, migration, or
rollback. `DONE` for this review means that the review evidence was recorded;
it does not mean that the release or deployment is approved.

## Reviewed target

- Repository: `https://github.com/hasna/emails.git` (`@hasna/emails`).
- Task branch: `1feac6c697c080ef2ef95542bfe51f7fb96fe22c`, an empty task marker on
  `975a363c936f6b6cd492b09d9c7d563ca003514e`.
- Public package: `@hasna/emails@1.3.3`, published 2026-07-28, registry SHA-1
  `fd0f3fd766f731b46a17e1bd9cc57a0fe891ee05` and SHA-256
  `e63d260defd80154a1da19c5698fb867d87467d5de2447daf3f90e4d64da543d`.
- No operator-owned live topology manifest, AWS account/region, immutable ECR
  reference, or live task/service evidence was supplied or found in the tree.

## Independent review tracks

The release track independently checked the Git remote and commit graph, npm
metadata and tarball bytes, package contents, GitHub Actions runs, workflow
triggers, and the deployment/rollback runbook. The security track separately
checked migrations and downgrade behavior, real-Postgres CI wiring, RLS and
tenant tests, super-admin bootstrap, inbound routing, outbound policy, and
secret-scanning coverage. Findings were reconciled only after both read-only
passes; neither track changed external or repository state.

## Evidence that passed

- Target identity is canonical: the local and GitHub remotes are
  `hasna/emails`, and current `origin/main` is `975a363`.
- The downloaded 1.3.3 tarball matches npm's SHA-1 and SHA-512 integrity,
  contains exactly 730 entries, has the expected package name/repository,
  bins, exports, dashboard files, license, README, and install helper, and has
  no sensitive-looking path or symlink.
- Current-main CI run `30450152909` passed all three jobs. Its container job
  built and exercised the Linux image, produced vulnerability reports and an
  SBOM, and rejected HIGH/CRITICAL findings. Its Postgres job passed the listed
  migration, tenant, RLS, message-ID, send, webhook, attachment-inventory, and
  store-conformance suites.
- The 1.3.3 source tree also passed pull-request CI run `30371070169`, including
  the local-mode container smoke. This is useful test evidence, but it does not
  satisfy the runbook's exact merged-main release gate below.
- `rls.integration.test.ts` proves fail-closed reads, cross-tenant read/write
  denial, a `NOSUPERUSER NOBYPASSRLS` serving role, load-bearing `FORCE ROW
  LEVEL SECURITY`, and policy presence. `multi-tenancy.integration.test.ts`
  covers the application-layer isolation matrix.
- The primary super-admin integration test proves paired email/KID
  configuration, wrong-tenant-key denial, race idempotency, singleton behavior,
  session denial, and an audit row without password/token/secret fields.
- Inbound tests route from trusted envelope recipients, ignore spoofed MIME
  recipients, and quarantine unresolved routes. The central outbound policy
  rejects unregistered/inactive/unverified/unready senders, unauthorized send
  keys, suppressions, quotas, and warming-limit violations before provider I/O.

## P1 closure blockers

1. **The published package is not bound to fresh release evidence.** The only
   provenance workflow is explicitly frozen to 1.3.2
   (`.github/workflows/package-provenance.yml:1,26-28`), while npm's current
   package is 1.3.3 and exposes no `gitHead`. The 1.3.3 source-head tree
   (`5c4b989`) and merge (`c743c35`) are identical, but merged-main CI run
   `30372055018` failed before the package was published. Current main is 83
   commits and 122 changed paths beyond that merge while retaining version
   1.3.3, so current source cannot be identified with the immutable published
   bytes by version alone.

2. **The documented exact-SHA Terraform CI gate is structurally
   unsatisfiable for an ordinary release commit.** The preflight requires both
   `ci.yml` and `terraform-aws-validate.yml` to have successful `push` runs for
   the exact merged release commit (`docs/DEPLOYMENT_CUTOVER.md:202-244`). The
   Terraform workflow runs on main pushes only when `deploy/aws/**` or
   `.github/workflows/**` changed
   (`.github/workflows/terraform-aws-validate.yml:8-12`). Neither the 1.3.3
   merge nor current main has that exact-SHA Terraform run.

3. **Required secret-scan evidence is absent.** CI runs Trivy vulnerability
   analysis and a product-boundary scan, but no gitleaks, TruffleHog,
   detect-secrets, GitHub secret scanning, or equivalent source/history scan is
   configured. The GitHub secret-scanning API reports that secret scanning is
   disabled. A local conservative pattern pass found no candidate in the
   packed tarball; that is not a replacement for the required staged and
   history-aware evidence.

4. **There is no live ECS image/deployment/smoke/rollback evidence.** The
   runbook itself says its generic Terraform rehearsal is unusable for the live
   topology and requires a separate independently reviewed live plan
   (`docs/DEPLOYMENT_CUTOVER.md:63-77`). No live topology manifest/hash, ECR
   digest and OCI labels, exact-image scan/SBOM, task-definition and service
   ARNs, no-SES smoke result, deployment observation, or rollback-drill result
   is present. The CI-built local image is not evidence about an immutable live
   ECR image or ECS deployment.

5. **Rollback documentation is one migration behind the code.** The runbook
   declares 0020 the latest cutover and allows only 0020-compatible recovery
   (`docs/DEPLOYMENT_CUTOVER.md:46-60`), but the migration list appends
   `0021_idp_principal_tenants`
   (`src/server/self-hosted/migrations.ts:2680-2708,2730-2737`). The migration
   ledger rejects an applied row unknown to an older binary
   (`src/storage-kit/migrations.ts:130-136`), so a 0020-only image is not a
   valid post-0021 restart or rollback target.

6. **Migration 0021's dedicated real-Postgres proof is not run by the
   real-Postgres CI job.** `idp.integration.test.ts` is gated on
   `EMAILS_TEST_POSTGRES_URL` and explicitly owns the 0021 real-SQL proof, but
   the `selfhost-postgres` invocation omits it
   (`.github/workflows/ci.yml:170-204`). Collection in the ordinary hermetic
   suite skips those cases and cannot replace the missing database run.

7. **Delivery events do not close the outbound suppression loop.** The
   self-hosted webhook records bounce/complaint events but deliberately does
   not update contact bounce/complaint counters or suppression, even though
   that suppression is what outbound policy reads
   (`src/server/self-hosted/webhooks.ts:184-192`). A recipient can therefore
   continue past the central gate after provider complaint/bounce evidence
   unless an operator suppresses it separately.

## Closure requirements

Release/deployment closure remains blocked until the repository-owned items
above are corrected and re-reviewed, and operator-owned live evidence proves
the exact target image, topology, migration state, tenant/RLS behavior,
bootstrap authorization/revocation, no-send smoke, and a 0021-compatible
rollback drill. No exception or waiver is recorded by this review.
