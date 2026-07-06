#!/usr/bin/env bun
import pkg from "../../package.json" with { type: "json" };
import { isCloudMode } from "./cloud/env.js";

const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-V")) {
  console.log(pkg.version);
  process.exit(0);
}
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: mailery-serve [options]

Runs the Mailery HTTP service.
  - cloud mode  (HASNA_MAILERY_STORAGE_MODE=cloud + HASNA_MAILERY_DATABASE_URL,
    or a platform-injected DATABASE_URL): the self_hosted PURE-REMOTE API
    (GET /health, /ready, /version and the API-key-authenticated /v1 surface),
    binding 0.0.0.0 by default.
  - local mode  (default): the SQLite-backed dashboard on 127.0.0.1.

Options:
  --host <host>      Host to bind to
  --port <port>      Port to listen on (default: cloud 8080 / local 3900)
  -V, --version      output the version number
  -h, --help         display help`);
  process.exit(0);
}

if (isCloudMode()) {
  const { startCloudServer } = await import("./cloud/serve.js");
  const port = process.env["PORT"] ? parseInt(process.env["PORT"], 10) : 8080;
  const host = process.env["HOST"] ?? "0.0.0.0";
  await startCloudServer(pkg.version, port, host);
} else {
  const { startServer } = await import("./serve.js");
  const port = process.env["PORT"] ? parseInt(process.env["PORT"], 10) : 3900;
  const host = process.env["HOST"] ?? "127.0.0.1";
  await startServer(port, host);
}
