# Self-hosted authentication

Authentication applies to the operator-owned self-hosted `/v1` service. The
local SQLite dashboard has a separate loopback-oriented trust boundary and does
not use these accounts.

## Client configuration

A self-hosted client sets the service URL and one bearer credential:

```bash
export EMAILS_SELF_HOSTED_URL="https://emails.example.com"
export EMAILS_SELF_HOSTED_API_KEY="..."   # operator or tenant API key
```

Setting the service URL is what selects the hosted client store; there is no
separate deployment-mode variable.

The accepted credential variables, in precedence order, are:

1. `EMAILS_SESSION_TOKEN` — an opaque user session created by `emails auth login`;
2. `EMAILS_IDP_TOKEN` — an access token from the configured identity provider;
3. `EMAILS_SELF_HOSTED_API_KEY` — an HMAC application or tenant API key.

`EMAILS_CLIENT_ENV_SECRET` may point to a `secrets` vault entry containing
`EMAILS_SELF_HOSTED_URL` and any one of those credentials.
`emails auth login`, `logout`, and `switch-tenant` update that entry when the
pointer is configured. Without it, a login token exists only in the current CLI
process and is not durable across later invocations.

## User and organization commands

```bash
emails auth signup --email owner@example.com --tenant-name Example
emails auth verify-email <token>
emails auth verify-email --resend --email owner@example.com
emails auth login --email owner@example.com
emails auth whoami
emails auth switch-tenant another-org
emails auth logout
```

Passwords are prompted without echo when omitted. In non-interactive use they
must be provided as options, so prefer a protected execution environment and do
not place them in shell history or source files.

The service permits signup, login, and invitations only for domains matching
`EMAILS_AUTH_ALLOWED_EMAIL_DOMAINS`. Signup requires email verification using
mail sent from `EMAILS_AUTH_FROM`; both service variables are required and have
no built-in defaults.

`emails auth bootstrap` is the one-time primary-owner path. It requires the
operator API key selected by the server's paired bootstrap email/KID settings;
matching the email alone is not authorization.

## Two API-key scopes

These similarly named commands manage different key classes:

- `emails self-hosted key create/list/rotate/revoke` runs on the operator host
  against Postgres and manages application keys used to establish the service.
- `emails keys create/list/revoke` calls `/v1/keys` as an owner/admin session and
  manages tenant-scoped keys for the active organization. A new plaintext token
  is shown once; lists never return tokens or hashes.

Scoped send keys under `emails sendkey` are a third, narrower authorization
mechanism: they bind an owner/agent to allowed From addresses rather than
authenticating a general `/v1` client.

## Optional IdP tokens

Migration `0021_idp_principal_tenants` adds the resolution mapping for IdP
principals. When the service sets `EMAILS_IDP_JWKS_URL`, it can verify Ed25519
access tokens with audience `emails`, map the token subject to an Emails tenant,
and enforce `emails:read`, `emails:write`, or `emails:*` scopes. The client puts
that token in `EMAILS_IDP_TOKEN`.

This is currently the verifier slice only: no `emails auth idp map/list/revoke`
commands are shipped. An unmapped or locally revoked principal fails closed,
and an unset JWKS URL refuses the IdP credential class. IdP-side revocation
stops new tokens, while an already issued token remains valid until expiry
unless its Emails mapping is revoked.

See [ADR-0001](adr/0001-adopt-tenants-idp-for-identity.md) and
[ADR-0002](adr/0002-agent-identity-signup-and-scopes.md) for the accepted target
architecture and the unimplemented later phases.
