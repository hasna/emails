# Feature conventions for agents

Use this checklist when adding behavior to `@hasna/mailery`. The project is a
CLI, MCP server, REST dashboard API, and public library over the same local
SQLite store, so new behavior should land in the right layer and get regression
coverage there.

## DB-backed feature

1. Add schema in `src/db/database.ts`.
2. Add idempotent `ensureSchema` coverage for the same table, columns, and
   indexes.
3. Add CRUD helpers in `src/db/<feature>.ts`.
4. Add focused tests in `src/db/<feature>.test.ts`.
5. Use `EMAILS_DB_PATH=:memory:` or a temp DB path in tests.

Regression example: ownership lives in `src/db/owners.ts`,
`src/lib/address-ownership.ts`, and `src/db/owners.test.ts`.

## CLI command

1. Register in the nearest `src/cli/commands/*.ts` module.
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

1. Register in `src/mcp/tools/*.ts`.
2. Return JSON text, not human-only prose, for agent-facing results.
3. Let the MCP contract wrapper add `cli_equivalent` and structured errors.
4. Add HTTP transport tests for high-use tools, not only direct helper tests.

Regression examples: `src/mcp/http.test.ts` and
`src/contracts/template-contact-sequence-parity.test.ts`.

## REST endpoint

1. Add routes in `src/server/routes/*.ts`, keeping `serve.ts` thin.
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
EMAILS_DB_PATH=:memory: bun test
npm pack --dry-run
```

For agent-facing changes, also smoke the built or globally installed CLI in a
fresh tmux session with a temp `HOME` and temp `EMAILS_DB_PATH`.
