#!/usr/bin/env bun
/**
 * Mailery MCP server entry point.
 */
import pkg from "../../package.json" with { type: "json" };
import { loadStagedCloudEnv } from "../lib/load-cloud-env.js";

// Route to the self-hosted /v1 API when the fleet flip creds are staged
// (~/.hasna/cloud/mailery.env), before the MCP server reads the cloud config.
loadStagedCloudEnv();

function printHelp(): void {
  console.log(`Usage: mailery-mcp [options]

Runs the @hasna/mailery MCP server. Transport: shared Streamable HTTP on 127.0.0.1
by default (one process, many agents); pass --stdio for a stdio server (one per client).

Options:
      --stdio        Serve MCP over stdio (one server per client) instead of HTTP
      --http         Serve MCP over Streamable HTTP on 127.0.0.1 (default)
  -p, --port <port>  HTTP port (default: MCP_HTTP_PORT or 8861)
  -V, --version      output the version number
  -h, --help         display help for command

Environment:
  MCP_STDIO=1        Select the stdio transport
  MCP_HTTP_PORT      Override default HTTP port (8861)`);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}

if (args.includes("--version") || args.includes("-V")) {
  console.log(pkg.version);
  process.exit(0);
}

async function main(): Promise<void> {
  const { isStdioMode, resolveHttpPort } = await import("./options.js");
  if (isStdioMode(args)) {
    const [{ StdioServerTransport }, { buildServer }] = await Promise.all([
      import("@modelcontextprotocol/sdk/server/stdio.js"),
      import("./server.js"),
    ]);
    const server = buildServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }
  // Default: shared Streamable HTTP server (one process per MCP, many agents).
  const { startHttpServer } = await import("./http.js");
  startHttpServer({ port: resolveHttpPort(args) });
  await new Promise<never>(() => {});
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
