import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_TEST_HTTP_TOKEN, mcpTestRequestInit, startTestMcpHttpServer } from "../test-support/mcp-http.js";
import {
  MCP_HTTP_ALLOWED_HOSTS_ENV,
  MCP_HTTP_ALLOWED_ORIGINS_ENV,
  MCP_HTTP_TOKEN_ENV,
  startHttpServer,
} from "./http.js";
import { defaultAllowedHosts, parseBearerToken, resolveAllowedHosts, tokensMatch } from "./http-auth.js";
import { resolveHttpPort } from "./options.js";

// The MCP HTTP transport publishes the whole tool graph — send_email,
// add_forwarding_rule (durable mail exfiltration), set_config, create_send_key.
// A loopback bind is not an authorization boundary: any local process reaches
// it, and a web page reaches it too by re-resolving its own hostname to
// 127.0.0.1 (DNS rebinding), which makes the request same-origin so CORS never
// applies. These tests pin the two controls that close that: a bearer token on
// /mcp, and a Host/Origin allowlist on every path.

const servers: Array<ReturnType<typeof startHttpServer>> = [];
const envKeys = [MCP_HTTP_TOKEN_ENV, MCP_HTTP_ALLOWED_HOSTS_ENV, MCP_HTTP_ALLOWED_ORIGINS_ENV, "MCP_HTTP_PORT"];
const savedEnv = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

function track(server: ReturnType<typeof startHttpServer>): ReturnType<typeof startHttpServer> {
  servers.push(server);
  return server;
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1.0.0" } },
});

async function postMcp(port: number, headers: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: INITIALIZE,
  });
}

/**
 * Raw HTTP/1.1 request so the `Host` header can be forged the way a rebound
 * browser tab would send it (`fetch` will not let us override `Host`).
 */
async function rawRequest(port: number, requestLine: string, headers: string[]): Promise<string> {
  const chunks: string[] = [];
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_socket, data) {
        chunks.push(new TextDecoder().decode(data));
      },
    },
  });
  socket.write(`${requestLine}\r\n${headers.join("\r\n")}\r\n\r\n`);
  const deadline = Date.now() + 5_000;
  while (chunks.length === 0 && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  socket.end();
  return chunks.join("");
}

describe("MCP HTTP transport refuses to run unauthenticated", () => {
  it("throws instead of binding a socket when no token is configured", () => {
    setEnv(MCP_HTTP_TOKEN_ENV, undefined);
    expect(() => startHttpServer({ port: 0, log: () => {} })).toThrow(/without a bearer token/);
  });

  it("rejects a blank or too-short token instead of accepting it", () => {
    setEnv(MCP_HTTP_TOKEN_ENV, "   ");
    expect(() => startHttpServer({ port: 0, log: () => {} })).toThrow(/without a bearer token/);
    setEnv(MCP_HTTP_TOKEN_ENV, "short");
    expect(() => startHttpServer({ port: 0, log: () => {} })).toThrow(/at least 16 characters/);
  });

  it("reads the token from the environment when the caller passes none", () => {
    setEnv(MCP_HTTP_TOKEN_ENV, "environment-supplied-mcp-token");
    const server = track(startHttpServer({ port: 0, log: () => {} }));
    expect(server.port).toBeGreaterThan(0);
  });
});

describe("MCP HTTP /mcp bearer token", () => {
  it("answers 401 with no Authorization header", async () => {
    const server = track(startTestMcpHttpServer());
    const response = await postMcp(server.port, {});

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    const body = (await response.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain("Unauthorized");
  });

  it("answers 401 for a wrong token, an empty bearer, and a non-bearer scheme", async () => {
    const server = track(startTestMcpHttpServer());
    for (const header of [
      { Authorization: "Bearer not-the-configured-token-value" },
      { Authorization: "Bearer " },
      { Authorization: "Bearer" },
      { Authorization: `Basic ${MCP_TEST_HTTP_TOKEN}` },
      { Authorization: MCP_TEST_HTTP_TOKEN },
    ]) {
      const response = await postMcp(server.port, header as Record<string, string>);
      expect(response.status).toBe(401);
    }
  });

  it("accepts the configured token (case-insensitive scheme) and serves MCP", async () => {
    const server = track(startTestMcpHttpServer());
    const response = await postMcp(server.port, { Authorization: `bearer ${MCP_TEST_HTTP_TOKEN}` });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("serverInfo");
  });

  it("never runs a tool for an unauthenticated caller", async () => {
    const server = track(startTestMcpHttpServer());
    const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_config", arguments: {} } }),
    });

    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("cli_equivalent");
  });
});

describe("MCP HTTP DNS-rebinding protection", () => {
  it("rejects a forged Host header on /mcp and on /health", async () => {
    const server = track(startTestMcpHttpServer());

    const mcp = await rawRequest(server.port, "POST /mcp HTTP/1.1", [
      `Host: attacker.example:${server.port}`,
      `Authorization: Bearer ${MCP_TEST_HTTP_TOKEN}`,
      "Content-Type: application/json",
      "Accept: application/json, text/event-stream",
      `Content-Length: ${INITIALIZE.length}`,
      "Connection: close",
      "",
      INITIALIZE,
    ]);
    expect(mcp).toContain("403");
    expect(mcp).toContain("attacker.example");
    expect(mcp).not.toContain("serverInfo");

    const health = await rawRequest(server.port, "GET /health HTTP/1.1", [
      `Host: attacker.example:${server.port}`,
      "Connection: close",
    ]);
    expect(health).toContain("403");
    expect(health).not.toContain('"status":"ok"');
  });

  it("still accepts loopback Host values", async () => {
    const server = track(startTestMcpHttpServer());
    for (const host of [`127.0.0.1:${server.port}`, `localhost:${server.port}`]) {
      const health = await rawRequest(server.port, "GET /health HTTP/1.1", [`Host: ${host}`, "Connection: close"]);
      expect(health).toContain("200");
      expect(health).toContain('"status":"ok"');
    }
  });

  it("rejects the opaque `null` Origin instead of treating it as absent", async () => {
    // Sent by sandboxed iframes, `data:`/`file:` documents, and some redirect
    // chains — all attacker-reachable browser contexts.
    const server = track(startTestMcpHttpServer());
    const response = await postMcp(server.port, {
      Authorization: `Bearer ${MCP_TEST_HTTP_TOKEN}`,
      Origin: "null",
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain("Origin");
  });

  it("rejects a cross-origin browser request even with a valid Host", async () => {
    const server = track(startTestMcpHttpServer());
    const response = await postMcp(server.port, {
      Authorization: `Bearer ${MCP_TEST_HTTP_TOKEN}`,
      Origin: "https://attacker.example",
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain("Origin");
  });

  it("allows the loopback origin and requests that carry no Origin at all", async () => {
    const server = track(startTestMcpHttpServer());
    const withOrigin = await postMcp(server.port, {
      Authorization: `Bearer ${MCP_TEST_HTTP_TOKEN}`,
      Origin: `http://127.0.0.1:${server.port}`,
    });
    expect(withOrigin.status).toBe(200);

    const withoutOrigin = await postMcp(server.port, { Authorization: `Bearer ${MCP_TEST_HTTP_TOKEN}` });
    expect(withoutOrigin.status).toBe(200);
  });

  it("honours the operator's Host and Origin allowlists", async () => {
    setEnv(MCP_HTTP_ALLOWED_HOSTS_ENV, "mcp.internal:9999");
    setEnv(MCP_HTTP_ALLOWED_ORIGINS_ENV, "https://console.internal");
    const server = track(startTestMcpHttpServer());

    const allowed = await rawRequest(server.port, "GET /health HTTP/1.1", ["Host: mcp.internal:9999", "Connection: close"]);
    expect(allowed).toContain("200");

    const denied = await rawRequest(server.port, "GET /health HTTP/1.1", [`Host: 127.0.0.1:${server.port}`, "Connection: close"]);
    expect(denied).toContain("403");
  });

  it("builds a loopback-only default allowlist and never widens a wildcard bind", () => {
    expect(defaultAllowedHosts("127.0.0.1", 8861).sort()).toEqual(["127.0.0.1:8861", "[::1]:8861", "localhost:8861"]);
    expect(defaultAllowedHosts("0.0.0.0", 8861)).not.toContain("0.0.0.0:8861");
    expect(resolveAllowedHosts("127.0.0.1", 8861, { [MCP_HTTP_ALLOWED_HOSTS_ENV]: " a.example:1 , b.example:2 " }))
      .toEqual(["a.example:1", "b.example:2"]);
  });
});

describe("MCP HTTP guard primitives", () => {
  it("parses only a well-formed bearer header", () => {
    expect(parseBearerToken("Bearer abc")).toBe("abc");
    expect(parseBearerToken("bearer\tabc")).toBe("abc");
    expect(parseBearerToken("Bearer  abc  ")).toBe("abc");
    expect(parseBearerToken("Bearer")).toBeUndefined();
    expect(parseBearerToken("Bearer   ")).toBeUndefined();
    expect(parseBearerToken("Token abc")).toBeUndefined();
    expect(parseBearerToken(null)).toBeUndefined();
  });

  it("compares tokens without leaking length through an exception", () => {
    expect(tokensMatch("same-token", "same-token")).toBe(true);
    expect(tokensMatch("a", "a-much-longer-token")).toBe(false);
    expect(tokensMatch("", "x")).toBe(false);
  });
});

describe("emails-mcp transport selection", () => {
  const entrypoint = join(import.meta.dir, "index.ts");

  function freePort(): number {
    const probe = Bun.serve({ port: 0, fetch: () => new Response("probe") });
    const port = probe.port;
    probe.stop(true);
    return port;
  }

  async function spawnEntrypoint(args: string[], env: Record<string, string>) {
    const home = mkdtempSync(join(tmpdir(), "emails-mcp-entry-"));
    const child = Bun.spawn([process.execPath, entrypoint, ...args], {
      env: { PATH: process.env["PATH"] ?? "", HOME: home, ...env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    return { child, cleanup: () => rmSync(home, { recursive: true, force: true }) };
  }

  it("defaults to stdio and opens no listening socket", async () => {
    const port = freePort();
    const { child, cleanup } = await spawnEntrypoint([], { MCP_HTTP_PORT: String(port) });

    try {
      // A stdio server answers JSON-RPC on stdout and never binds a port.
      child.stdin.write(`${INITIALIZE}\n`);
      await child.stdin.flush();

      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let out = "";
      const deadline = Date.now() + 20_000;
      while (!out.includes("serverInfo") && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        out += decoder.decode(value, { stream: true });
      }
      expect(out).toContain("serverInfo");

      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    } finally {
      child.kill();
      await child.exited;
      cleanup();
    }
  }, 30_000);

  it("refuses to start the opt-in HTTP transport without a token", async () => {
    const port = freePort();
    const { child, cleanup } = await spawnEntrypoint(["--http", "--port", String(port)], {});

    try {
      const exitCode = await child.exited;
      const stderr = await new Response(child.stderr).text();
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("without a bearer token");
      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    } finally {
      cleanup();
    }
  }, 30_000);
});

describe("resolveHttpPort", () => {
  it("honours the --port=<n> equals form instead of silently ignoring it", () => {
    expect(resolveHttpPort(["--port=9101"])).toBe(9101);
    expect(resolveHttpPort(["-p=9102"])).toBe(9102);
    expect(resolveHttpPort(["--http", "--port=9103"])).toBe(9103);
  });

  it("still honours the separate-argument form and the env fallback", () => {
    expect(resolveHttpPort(["--port", "9104"])).toBe(9104);
    expect(resolveHttpPort(["-p", "9105"])).toBe(9105);
    setEnv("MCP_HTTP_PORT", "9106");
    expect(resolveHttpPort([])).toBe(9106);
  });

  it("rejects non-decimal port spellings rather than coercing them", () => {
    for (const argv of [["--port=0x2255"], ["--port=1e4"], ["--port="], ["--port=-1"], ["--port=70000"]]) {
      expect(() => resolveHttpPort(argv)).toThrow(/Invalid port/);
    }
  });
});
