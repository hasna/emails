#!/usr/bin/env bun
import pkg from "../../package.json" with { type: "json" };
import { assertNoLegacyHostedEnvironment } from "../lib/mode.js";
import { resolveServerBindOptions } from "./bind-options.js";
import { resolveServerStorageBackend } from "./storage-backend.js";

const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-V")) {
  console.log(pkg.version);
  process.exit(0);
}
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: emails-serve [command] [options]

Runs the Emails HTTP service (or a background worker).

Commands:
  (default)          Run the HTTP service. Which one follows the internal store
                     this server is configured with, and nothing else:
                       - PostgreSQL (EMAILS_DATABASE_URL +
                         EMAILS_API_SIGNING_KEY): the operator-owned Postgres API
                         (GET /health, /ready, /version and the API-key
                         authenticated /v1 surface), binding 0.0.0.0.
                       - SQLite (EMAILS_DATABASE_URL unset): the SQLite
                         dashboard on 127.0.0.1.
  ingest-worker      Run the SES-inbound ingestion worker: long-poll the SQS
                     queue (EMAILS_INGEST_QUEUE_URL), fetch each archived raw
                     message from S3, and write it to self-hosted Postgres.
  ingest-s3-backfill One-shot repair/backfill: list EMAILS_INGEST_S3_BUCKET /
                     EMAILS_INGEST_S3_PREFIX and ingest existing raw objects.
  attachment-repair-canary
                     Exact-ID, exact-object attachment repair. Dry-run unless
                     --apply is passed; never inserts or updates other fields.
  attachment-repair-ledger
                     Operator-only, image-bundled checkpoint ledger maintenance.
                     Reads one canonical secret manifest, proves ECS/image
                     provenance, and emits aggregate JSON only.
  inbound-provenance-audit
                     Read-only all-tenant post-fence provenance audit. Emits
                     aggregate counts only and exits nonzero on any gap.
  inbound-provenance-fence
                     Capture a privacy-safe cutoff from PostgreSQL's clock.
                     Pre-0017 compatible and accepts no options.

Options:
  --host <host>      Host to bind to (local non-loopback requires
                     EMAILS_ALLOW_REMOTE=1)
  --port <port>      Port to listen on (default: postgresql 8080 / sqlite 3900)
  --message-id <id>  Exact message canary; repeat for every row bound to the object
  --object-key <key> One exact S3 object key (repair command only)
  --recipient <addr> Trusted envelope recipient (repeatable; repair command only)
  --region <name>    AWS region (repair command; else AWS_REGION)
  --since <ISO8601>  Required post-fence cutoff (provenance audit only)
  --apply            Apply attachment-only CAS after reviewed dry-run
  -V, --version      output the version number
  -h, --help         display help`);
  process.exit(0);
}

// EVERY command fails closed on a removed hosted/legacy variable, ahead of dispatch.
// This is deliberately eager while the storage resolution below is lazy: the legacy
// variables configure a runtime that no longer exists, so honouring one for a worker
// while refusing it for the service would be a silent difference between two entry
// points of the same binary. The STORE, by contrast, is resolved only by the branches
// that actually open one — the workers and one-shot commands validate their own
// PostgreSQL, signing and AWS requirements after dispatch, and must be able to report a
// bad flag without a database being configured at all.
assertNoLegacyHostedEnvironment();

function repeated(flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === flag && args[index + 1]) values.push(args[++index]!);
  }
  return values;
}

function option(flag: string): string | undefined {
  return repeated(flag)[0];
}

if (args[0] === "ingest-worker") {
  if (args.includes("--bucket")) {
    throw new Error("ingest worker does not accept --bucket; EMAILS_INGEST_S3_BUCKET is the only canonical source");
  }
  const { runIngestWorker } = await import("./self-hosted/ingest-worker.js");
  await runIngestWorker();
} else if (args[0] === "ingest-s3-backfill") {
  if (args.includes("--bucket")) {
    throw new Error("ingest S3 backfill does not accept --bucket; EMAILS_INGEST_S3_BUCKET is the only canonical source");
  }
  const { runIngestS3Backfill } = await import("./self-hosted/ingest-worker.js");
  await runIngestS3Backfill();
} else if (args[0] === "attachment-repair-canary") {
  if (args.includes("--bucket")) {
    throw new Error("attachment repair does not accept --bucket; immutable stored provenance selects the canonical bucket");
  }
  const { runAttachmentRepairCanary } = await import("./self-hosted/ingest-worker.js");
  await runAttachmentRepairCanary({
    region: option("--region"),
    objectKeys: repeated("--object-key"),
    recipients: repeated("--recipient"),
    canaryMessageIds: repeated("--message-id"),
    apply: args.includes("--apply"),
  });
} else if (args[0] === "attachment-repair-ledger") {
  const { runAttachmentRepairMaintenanceCommand } =
    await import("./self-hosted/attachment-repair-maintenance.js");
  await runAttachmentRepairMaintenanceCommand(args.slice(1));
} else if (args[0] === "inbound-provenance-audit") {
  const sinceValues = repeated("--since");
  if (args.length !== 3 || args[1] !== "--since" || sinceValues.length !== 1) {
    throw new Error("inbound provenance audit requires exactly one --since <ISO8601> and accepts no other options");
  }
  const { runInboundProvenanceAudit } = await import("./self-hosted/ingest-worker.js");
  await runInboundProvenanceAudit({ since: sinceValues[0]! });
} else if (args[0] === "inbound-provenance-fence") {
  if (args.length !== 1) {
    throw new Error("inbound provenance fence accepts no options");
  }
  const { runInboundProvenanceFence } = await import("./self-hosted/ingest-worker.js");
  await runInboundProvenanceFence();
} else {
  // The `switch` is exhaustive over `ServerStorageBackend`, so a third backend arm would
  // fail to compile here — the intended structural limit, not an oversight.
  const backend = resolveServerStorageBackend();
  const { port, host } = resolveServerBindOptions(args, process.env, backend);
  switch (backend) {
    case "postgresql": {
      const { startSelfHostedServer } = await import("./self-hosted/serve.js");
      await startSelfHostedServer(pkg.version, port, host);
      break;
    }
    case "sqlite": {
      const { startServer } = await import("./serve.js");
      await startServer(port, host);
      break;
    }
  }
}
