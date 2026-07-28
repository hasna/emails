# ADR-0002 — Agent identity: signup flow, scope model, audit, and contracts

- Status: **Accepted** (owner ruling, 2026-07-28 — see ADR-0001)
- Date: 2026-07-28
- Deciders: owner; drafted by the tenants-federation working session
- Depends on: [ADR-0001 — Adopt `@hasna/tenants` as the identity authority](0001-adopt-tenants-idp-for-identity.md)

## Context

Agents today authenticate to emails by materializing the **owner's** client-env
bundle from the vault: every agent is indistinguishable from the owner, cannot
be individually revoked, and leaves no per-agent audit trail. The owner ruling
makes per-agent identity mandatory: an agent gets its **own revocable
identity**, issued by the org IdP, never a copy of anyone's credential
bundle.

The IdP building blocks exist (`service_principals` table, `pt: "service"`
token claims) but the issuance surface does not — see the prerequisites named
in ADR-0001. This ADR fixes the end-to-end flow, the CLI ownership, the scope
model, and the audit events so both repos build toward one design.

## Decision 1 — The signup flow, end to end

```
                 (1) create                        (2) mint token
 operator ──► tenants CLI/API ──► service_principal ──► IdP token (pt=service,
                 │                 in @hasna/tenants      aud=emails, scope=[…],
                 │                                        sub=<principal-id>, ≤24h)
                 │ (3) map — one deliberate grant                │
                 └──► emails: idp_principal_tenants row        │
                      (sub → emails tenant [+ revoked_at])       ▼
                                              (4) agent calls emails /v1 with the
                                                  token; server verifies via JWKS,
                                                  maps sub → tenant, enforces scopes
                                              (5) revoke: IdP disable (kills issuance,
                                                  ≤24h residual) and/or emails map
                                                  revoke (immediate, mail only)
```

1. **Create the agent's identity in the IdP** (owning tenant, display name,
   granted scopes). This is the `open-tenants` prerequisite: principal
   creation plus an **enrollment credential** the agent holds — the agent
   exchanges it daily for short-lived IdP tokens; it never holds a password
   or a long-lived app key. Proposed verbs (to land in `open-tenants`):

   ```
   tenants principals create --tenant <slug> --name <agent-name> \
       --scope emails:read --scope emails:write
   tenants principals token <principal-id> --app emails [--ttl <seconds>]
   tenants principals disable <principal-id>
   tenants principals list --tenant <slug>
   ```

2. **Mint an IdP token** for `--app emails`. Claims per the ADR-0001 wire
   contract; `pt: "service"`, `sub` = principal id, TTL ≤ 24 h.

3. **Grant mail access in emails** — an explicit mapping row, created by an
   emails admin/owner (or the operator key):

   ```
   emails auth idp map <sub> [--tenant <slug>] [--note <text>]
   emails auth idp list
   emails auth idp revoke <sub>
   ```

   The mapping records the IdP tenant (`tid`) observed at grant time; a token
   whose `tid` no longer matches is refused (a principal moved between IdP
   tenants does not silently keep old mail access).

4. **The agent uses the token** as its bearer credential (client env:
   `EMAILS_IDP_TOKEN`); `emails auth whoami` shows the IdP principal, its
   emails tenant and effective scopes. The server derives everything from the
   token + mapping; the client never sends a tenant.

5. **Revocation** — two independent kill switches, both auditable:
   - IdP: `tenants principals disable` stops all new tokens for every app at
     once (residual ≤ 24 h for outstanding tokens until the introspection
     prerequisite lands — stated honestly in ADR-0001).
   - Emails: `emails auth idp revoke <sub>` sets `revoked_at` on the mapping
     and fails that principal closed on the next request — immediate, mail
     only.

### CLI ownership: tenants-CLI-first (rejected: `emails auth agent-signup`)

Principal **creation lives in the `tenants` CLI**; the `emails` CLI only
accepts the result (verify + map). An `emails auth agent-signup` that creates
IdP principals was rejected because:

- It would require IdP admin credentials to flow through the emails CLI — a
  confused-deputy magnet and precisely the credential-forwarding pattern this
  programme removes.
- The pattern must generalize to N apps × 1 IdP. Per-app signup verbs mean N
  reimplementations of principal creation and N privileged credential paths;
  one IdP-owned verb means one.
- The two-step ceremony (IdP creates WHO; emails grants WHAT-MAIL) is the
  security property, not friction: each side's admin makes an explicit,
  auditable decision in their own domain.
- Cost accepted: onboarding touches two CLIs. Mitigated by `emails auth idp
  map` printing the exact `tenants` command when the referenced principal does
  not exist yet, and by one onboarding skill composing both.

## Decision 2 — Scope model

IdP tokens carry emails scopes in the shared `<app>:<action>` grammar
(`@hasna/contracts/auth` scope helpers; wildcard on the grant side only):

| Grant | Meaning | Existing gate it satisfies |
| --- | --- | --- |
| `emails:read` | read-mailbox: list/read messages, domains, addresses, contacts | every read gate |
| `emails:write` | send-as + mutations: send, drafts, contacts, templates | every write gate |
| `emails:*` | admin: everything an API key can do, incl. tenant-operator maintenance (`isTenantOperator`) | wildcard |

This deliberately reuses the exact scope vocabulary the API-key class already
enforces, so one scope check (`hasAllScopes`) serves all credential classes
and no route grows a special IdP branch. Two constraints named for later,
not smuggled in now:

- **Finer send-only scope** (`emails:send` distinct from `emails:write`):
  requires splitting today's write gate; tracked as scope-registry work in
  contracts (below), adopted by emails and the IdP's grant UI together.
- **Send-as address restriction** (an agent may send only from
  `agent-x@domain`): an authorization property of the *mapping*, not the
  token — a designed extension column on `idp_principal_tenants`
  (`allowed_from_addresses`), enforced where send authority is already
  checked. Out of the first slices.

Role gates are unaffected: IdP principals are never `principalType:"user"`,
so human/session-only surfaces (member management, invitations, password
flows) remain unreachable with an IdP token regardless of scopes — same
containment the API-key class has today.

## Decision 3 — Audit events

IdP auth reuses the structured, secret-free audit discipline of the API-key
path (`[api-auth]` lines in serve.ts). New events, all carrying `sub`, `jti`,
outcome and typed reason — never the token:

| Event | When | Minimum fields |
| --- | --- | --- |
| `idp.auth.allow` / `idp.auth.deny` | every IdP-token authentication decision | outcome, sub, tid, jti, kid, reason, method, path, status, at |
| `idp.map.create` | mapping row created | sub, emails tenant, granted by (user id / kid), note |
| `idp.map.revoke` | mapping revoked | sub, emails tenant, revoked by, reason |
| `idp.jwks.refresh` / `idp.jwks.error` | JWKS cache refresh / fetch failure | url host, kid set, error class |

Phase 1 emits these as structured log lines (parity with `[api-auth]`); a
durable `audit_log` table is a later, separate decision shared with the
API-key path. The IdP audits issuance on its side (`jti` is the join key
between the two audit domains).

## Decision 4 — What belongs in `@hasna/contracts` (describe only — no
implementation in this programme)

A new `@hasna/contracts/auth` idp module, so tenants, emails, and every next
app share one definition instead of pinning copies:

- **Claims schema**: `IdpAccessTokenClaims` = `{ iss, aud, sub, tid, pt,
  scope, iat, exp, jti }` with `pt: "user" | "service"`.
- **Wire constants**: the fixed issuer string (`identities` today — renaming it
  is a coordinated org-wide change and stays out of scope), the algorithm
  (`EdDSA`), the token type (`at+jwt`), the ≤ 24 h TTL ceiling.
- **JWKS shapes**: the Ed25519 public JWK and JWKS document types, plus the
  well-known path convention.
- **Verify surface**: options (jwks, expected audience, leeway) and a **closed
  set of typed failure reasons** (`malformed | unsupported_alg | missing_kid |
  unknown_kid | bad_signature | issuer_mismatch | audience_mismatch | expired |
  not_yet_valid`) so every app refuses identically and audit lines are
  comparable org-wide.
- **Structural detector** (is this bearer token an IdP JWS?) so credential
  dispatch is uniform across apps.
- **Scope registry pattern**: per-app scope-name constants (emails contributes
  `emails:read` / `emails:write` / `emails:*`) validated by the existing scope
  grammar helpers, giving the IdP's grant surface a source of truth for what
  each app accepts.
- **Documented mapping-table pattern**: each verifying app owns a
  `idp_principal_tenants`-shaped table (`sub → app tenant`, `tid` pin,
  `revoked_at`) — a convention description, not shipped code.

Until that module exists, open-tenants (`idp/tokens.ts`) and emails (the
Phase-1 verifier) each pin the wire values in their own tests; the contracts
migration then replaces both implementations with one import and deletes the
duplicated pins.

## Consequences

- An agent is onboarded in two explicit, auditable steps and revoked in one;
  the owner-bundle pattern is retired as Phase 2 of ADR-0001 lands.
- The `open-tenants` prerequisites (deployed instance; principal
  create/token/disable; introspection) gate the end-to-end flow and are filed
  as tasks there — emails ships its verifying half first, fail-closed.
- One scope vocabulary spans credential classes; scope evolution (send-only,
  send-as restriction) has a named home instead of ad-hoc per-app drift.
