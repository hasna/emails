# Feature conventions for agents

Use this checklist when adding behavior to `@hasna/emails`. The project is a
CLI, MCP server, local dashboard API, self-hosted `/v1` service, and public
library. Storage behavior may need both the local SQLite store and the HTTP/
Postgres path, so new behavior should land at the shared store seam where
possible and get regression coverage at each exposed layer.

## DB-backed feature

1. Add local schema in `src/db/database.ts` and idempotent `ensureSchema`
   coverage for the same table, columns, and indexes.
2. If the feature is self-hosted, add an immutable migration in
   `src/server/self-hosted/migrations.ts` and tenant/RLS coverage where the row
   is tenant-scoped.
3. Put shared operations on the relevant `src/store/` repository and implement
   them for SQLite and HTTP, or document a typed capability refusal.
4. Add focused DB/store tests and extend the shared conformance suite when the
   operation belongs to the store contract.
5. Use `EMAILS_DB_PATH=:memory:` or a temp DB path for local tests; real
   Postgres suites are gated by `EMAILS_TEST_POSTGRES_URL`.

Regression example: ownership lives in `src/db/owners.ts`,
`src/lib/address-ownership.ts`, and `src/db/owners.test.ts`.

## CLI command

1. Register in the nearest `src/cli/commands/*.ts` module. If behavior differs
   by selected store, keep the shared command shape stable and route the
   implementation through the existing local/remote facade.
2. Return structured data through the shared `output(data, formatted)` callback
   whenever practical.
3. If a command still logs directly, `--json` must stay parseable through the
   shared CLI runtime fallback.
4. Use `handleError`/`resolveId` so JSON mode gets structured errors and fix
   commands.
5. Add command or process-level tests for agent-facing JSON output.

Regression examples: `src/cli/cli-contract.test.ts`,
`src/cli/commands/address.test.ts`, and `src/cli/commands/provision.test.ts`.

## MCP tool

1. Register in `src/mcp/tools/*.ts` and wire any new registrar from
   `src/mcp/server.ts`.
2. Return JSON text, not human-only prose, for agent-facing results.
3. Let the MCP contract wrapper add `cli_equivalent` and structured errors.
4. Add HTTP transport tests for high-use tools, not only direct helper tests.

Regression examples: `src/mcp/http.test.ts` and
`src/contracts/template-contact-sequence-parity.test.ts`.

## REST endpoint

1. Add local dashboard routes in `src/server/routes/*.ts`, keeping `serve.ts`
   thin. Add self-hosted `/v1` behavior to the service/store and its OpenAPI
   contract in `src/server/self-hosted/`.
2. Redact provider credentials before returning provider-shaped objects.
3. Prefer route-dispatcher tests for fast API parity coverage.

Regression examples: `src/server/routes/core-redaction.test.ts` and
`src/server/routes/rest-parity.test.ts`.

## Public library export

1. Export intentional public functions from `src/index.ts`.
2. Document the import shape in `README.md`.
3. Add or update `src/index.test.ts` so package consumers can import the API.

## Release gate

Before publishing a release:

```bash
bun run build
bun run test
npm pack --dry-run
```

For agent-facing changes, also smoke the built or globally installed CLI in a
fresh tmux session with a temp `HOME` and temp `EMAILS_DB_PATH`.
