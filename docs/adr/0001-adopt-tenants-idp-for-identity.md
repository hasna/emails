# ADR-0001 — Adopt `@hasna/tenants` as the identity authority for `@hasna/emails`

- Status: **Accepted** (owner ruling, 2026-07-28: *"we need to fix all this and we
  need to adhere to hasna/tenants"*)
- Date: 2026-07-28
- Deciders: owner; drafted by the tenants-federation working session
- Companion: [ADR-0002 — Agent identity, signup, and scopes](0002-agent-identity-signup-and-scopes.md)
- Related design: [`docs/design/multi-tenancy-auth.md`](../design/multi-tenancy-auth.md)
  (the private multi-tenancy build this ADR federates and then supersedes in part)

## Context

### What emails has today (verified in this tree)

`@hasna/emails` grew a complete, **private** identity system as part of the
multi-tenancy build (design doc §3–§6, migrations `0012`/`0013` in
`src/server/self-hosted/migrations.ts`):

- Its own `tenants`, `users`, `memberships`, `sessions`, `invitations`,
  `api_key_tenants`, `send_key_tenants` tables (migrations.ts ~:1489+). These are
  the **resolution layer**: read before a tenant is known, deliberately outside
  the generic resource surface and outside RLS.
- Its own signup/login/verify/bootstrap-owner surface (`/v1/auth/*`,
  `src/server/self-hosted/auth/service.ts`) and CLI (`src/cli/commands/auth.ts`).
- Two credential classes, dispatched by prefix in `resolveRequestContext`
  (auth/service.ts:119): `hasna_…` HMAC API keys verified via
  `@hasna/contracts/auth` and mapped to a tenant through `api_key_tenants`, and
  `emss_…` opaque user sessions. The server derives the tenant from the
  credential; the client never sends one.
- Tenant isolation in three layers (design §6): a tenant-scoped store, forced
  Postgres RLS keyed on `app.current_tenant` (with the boot guard in
  `rls-guard.ts`), and `NOT NULL tenant_id` on every data table.

Production (the deployed self-hosted service, server 1.3.0) runs this with real tenants,
~325 addresses and ~170k messages. **Agents currently authenticate by
materializing the owner's client-env bundle from the vault** — every agent is
the owner. That works and is the problem: no per-agent identity, no per-agent
revocation, no per-agent audit line.

### What the org IdP provides

`@hasna/tenants` 0.2.0 is the org tenant-auth IdP: tenants, users,
memberships, **service principals**, sessions, an OTP login front door, and
**asymmetric (EdDSA/Ed25519) access tokens** with a published JWKS. It is
explicitly distinct from `@hasna/identities` (the agent registry).

The token wire contract (open-tenants `src/idp/tokens.ts`) is:

- Compact JWS, header `{ alg: "EdDSA", kid, typ: "at+jwt" }`.
- Claims `{ iss, aud, sub, tid, pt, scope, iat, exp, jti }`:
  `iss` is the **fixed issuer string `identities`** (an org-wide wire
  contract, not a code dependency on the agent registry); `aud` is the app slug
  the token is for; `sub` is the principal id (user or service principal);
  `tid` is the IdP tenant UUID; `pt` is `user | service`; `scope` uses the
  `<app>:<action>` / `<app>:*` / `*` grammar shared with
  `@hasna/contracts/auth`.
- TTL is server-bounded at **≤ 24 h** — a caller can shorten a token's life,
  never extend it.
- Verification is **stateless**: any app holding the published JWKS
  (`/v1/.well-known/jwks.json`) verifies signature, issuer, audience and expiry
  offline. The IdP never holds another app's signing secret, so an IdP-side
  compromise cannot forge an app's HMAC keys, and an app-side compromise cannot
  mint IdP tokens.

### Verified gaps (2026-07-28) — named, not worked around

1. **No deployed IdP instance.** The expected IdP host's `/.well-known/jwks.json`
   returns HTTP 404 `{"error":"no matching host route"}`; no vault entries for a
   tenants API URL exist; the installed `tenants` CLI (0.2.0) requires
   `HASNA_TENANTS_API_URL` and has nothing to point at.
   → prerequisite task filed against `open-tenants` (deploy an org instance).
2. **No service-principal signup or token path.** The `service_principals`
   table and `store.createServicePrincipal` exist, but no HTTP route or CLI
   verb creates one, and `POST /v1/auth/token` mints `pt: "user"` tokens from
   sessions only. → prerequisite task filed against `open-tenants`
   (service-principal enrollment + `pt: "service"` issuance; see ADR-0002).
3. **Revocation is invisible to stateless verifiers.** The jti denylist is
   enforced only by the tenants service's own `/v1` surface. An app verifying
   via JWKS alone keeps accepting a revoked token until it expires (≤ 24 h).
   → prerequisite task filed against `open-tenants` (introspection/revocation
   feed), and this ADR designs around the bound honestly (below).

## Decision

**`@hasna/tenants` is the identity authority for emails.** The target state is:
every WHO-question — human users, agents/service principals, login, OTP,
session issuance, token issuance, credential revocation — is answered by the
org IdP. Emails keeps only the **data plane**: tenant-scoped mail rows, RLS,
per-tenant roles/scopes, and an explicit mapping from IdP principals to
emails tenants.

Concretely:

1. **Federation of identity, local ownership of mail data.** Emails keeps its
   own `tenants` rows and `tenant_id`/RLS machinery as the *data-scoping*
   boundary (WHAT-MAIL). It accepts **access tokens minted by the IdP**, verified
   statelessly against the published JWKS, and maps the token's `sub` to an
   emails tenant through an explicit, additive mapping table
   (`idp_principal_tenants`, mirroring `api_key_tenants`). The IdP owns WHO;
   emails owns WHAT-MAIL and *which IdP principal may act in which mail
   tenant*.
2. **The private auth surface becomes a legacy shim with a stated sunset**
   (migration plan below). New signups — human AND agent — go through the IdP
   from day one once an instance is deployed. Nothing existing breaks at any
   step; the `hasna_` API-key path stays a supported credential class until
   every issued key has been migrated and revoked.
3. **Fail-closed adoption.** Until an operator configures the JWKS source
   (`EMAILS_IDP_JWKS_URL`), the IdP credential class is refused with a
   typed error. Verification pins the wire contract (issuer `identities`,
   EdDSA, `at+jwt`, audience `emails` — plus the `mailery` alias for parity
   with the API-key verifier in `api-key-verifier.ts`).

### Naming: the credential class is called `idp` inside emails

Everything emails-side is named after the issuer's ROLE — `idp` — never after
the org-infrastructure noun the tenants package uses in its own prose:
`EMAILS_IDP_JWKS_URL`, `EMAILS_IDP_TOKEN`, `idp_principal_tenants`,
`principal_type: "idp"`, `[idp-auth]`/`[idp-jwks]` audit tags, `idp_*` typed
reasons. Two reasons. First, precision: from this product's point of view the
counterparty IS an identity provider; which org runs it is irrelevant to the
verification code. Second, this repo's no-cloud boundary
(`scripts/no-cloud-scan-lib.mjs`, "hosted implementation vocabulary") bans the
hosted-infrastructure noun across the whole corpus with no path allowance —
that guard protects the product's operator-owned identity and this programme
deliberately does not weaken it. No wire value is affected: the issuer string,
claims shape, and scope grammar carry no such vocabulary.

### Why not full delegation of the tenancy tables

The rejected alternative is deleting emails' `tenants`/`users`/`memberships`
tables and pointing every `tenant_id` FK at the IdP's database (or resolving
tenancy per-request from the IdP). Rejected because:

- **Availability coupling.** Mail ingest, RLS policy evaluation and the
  ingest worker resolve tenants on every request/message. A synchronous IdP
  dependency puts IdP availability in the mail hot path; an IdP outage
  would stop mail. Token verification via cached JWKS has no such coupling.
- **Referential integrity across services.** 27 data tables FK
  `tenant_id → tenants(id)` locally and RLS policies compare against a local
  GUC. Cross-database FKs don't exist; dropping the FKs to point at a remote
  system trades a real integrity guarantee for a convention.
- **The product must work standalone.** `@hasna/emails` is an OSS self-hosted
  product. A single operator on their own box must be able to run it without
  standing up a second identity service. Federation is opt-in configuration;
  delegation would be a hard dependency.
- **Migration risk.** The prod dataset (325 addresses, 170k messages) is keyed
  to local tenant UUIDs; rekeying data tenancy to IdP-issued UUIDs is a
  destructive migration with nothing to buy — the mapping table gives the same
  end-state semantics additively.
- **The IdP is 0.2.0 and not deployed.** A system of record cannot be a
  service that does not yet run anywhere. Federation lets emails ship the
  verifying side now and light it up when the prerequisite lands.

Direction of truth, stated once: **the IdP owns identity and the issuance /
revocation of identity credentials. Emails owns the authorization mapping
(IdP principal → emails tenant + role/scopes) and all mail data.** The
mapping is explicit — never inferred from slug equality or email domain — so
every cross-domain grant is a deliberate, auditable row.

## Migration plan — committed, phased, nothing breaks at any step

Every phase is additive or flag-gated; every removal is gated on measured zero
traffic, not on calendar time. Existing credentials keep working within each
phase; a credential class is only retired after its inventory reaches zero.

**Phase 1 — IdP-token verification slice** *(this repo, first committed step —
not a proof of concept)*. The server verifies EdDSA IdP tokens against a
configured JWKS URL (fail-closed when unconfigured, typed refusal), maps `sub`
through the new additive `idp_principal_tenants` table, and `emails auth
whoami` works with an IdP token. Existing `hasna_`/`emss_` behaviour is
byte-equivalent (proved by the existing suite). Ships dark until the IdP
deploys.

**Phase 2 — Mapping management + agent onboarding.** `emails auth idp
map|list|revoke` (admin/owner session or operator key), IdP auth audit lines,
and the end-to-end agent flow of ADR-0002 once the IdP's service-principal
prerequisite lands. The owner-bundle agent pattern is deprecated the day this
lands: new agents get service principals, never the owner's credentials.

**Phase 3 — Human sign-in federates.** `emails auth login` gains the IdP path
(OTP via the IdP front door; the IdP mints an `aud: emails` token; emails
verifies it and mints its own short-lived `emss_` session from it, so all
existing session-based server code and the dashboard keep working — sessions
become *derivative* of an IdP authentication event, not an independent root of
trust). Additive column `users.idp_sub` links local users to IdP principals
on first federated login. Password login remains available but is marked
deprecated; new signups are directed to the IdP. The private password/signup
path is put behind an operator flag whose default still allows it (no
breakage).

**Phase 4 — Credential migration: API keys and send keys.**
1. *Inventory*: enumerate active `hasna_` keys per tenant
   (`api_keys ⨝ api_key_tenants`) and send keys (`send_key_tenants`), each with
   `last_used_at`.
2. *Re-issue*: for each key, create an IdP service principal (or link the
   owning human), add the `idp_principal_tenants` row, and switch the
   consumer to IdP tokens.
3. *Cutover per credential*: watch audit lines until the legacy kid goes
   quiet; then revoke that key (`emails keys revoke`). Per-key cutover — never
   big-bang.
4. *Retire issuance first*: once inventory trends to zero, key **minting** is
   disabled (typed 410 pointing at the IdP flow) while **verification** of
   the remaining tail continues. The class is removed only at zero inventory,
   in a major version.

**Phase 5 — Sunset the private auth shim.** Remove private signup/OTP/password
login once: (a) every active user has `idp_sub` linked, (b) audit shows zero
password logins and zero legacy-key verifications over an agreed window, and
(c) owner sign-off. Local `users`/`memberships` rows survive as the
authorization/role layer (renamed conceptually to "principal directory");
`password_hash` and the verification/reset token tables are dropped. Emails'
`tenants` table survives indefinitely — it is the data-plane boundary, not an
identity artifact.

Phases 2–5 are tracked as tasks under the "IdP federation + agent
signup" umbrella (todos project `1631772c`) with explicit dependencies,
including the three `open-tenants` prerequisite tasks named above.

## Revocation, stated honestly

Until the `open-tenants` introspection prerequisite lands, IdP-side revocation
of a principal stops **new** tokens immediately but leaves already-minted
tokens valid for up to their ≤ 24 h TTL against stateless verifiers. Emails
therefore keeps a local kill switch: `idp_principal_tenants.revoked_at`
fails that principal closed on the next request regardless of token validity.
"Revocation via the IdP kills access everywhere" is exact for issuance,
bounded by 24 h for outstanding tokens, and immediate when paired with the
emails-side mapping revocation — ADR-0002 specifies the operator flow.

## Consequences

- Agents and humans get one org-wide identity that works across apps; emails
  stops being an identity island. Per-agent revocation and audit become real.
- Two new operational requirements: a deployed IdP (prerequisite task) and
  JWKS reachability from the emails server (cached, with fail-closed refusal
  and a typed unavailability error — never fail-open).
- The emails codebase carries three credential classes during the migration
  window. Cost accepted; the dispatch point is a single function
  (`resolveRequestContext`) and each class is independently testable.
- The wire contract (issuer string, claims shape, scope grammar) becomes
  load-bearing across repos. It must graduate into `@hasna/contracts` so
  tenants and every verifying app import one definition — ADR-0002 §Contracts
  describes the shape; implementation there is deliberately out of scope here.
- Until contracts owns it, both repos pin the contract values in tests; a
  drift breaks a test, not production.
