import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import { resetMailDataSource } from "../lib/mail-data-source.js";

// CLI <-> MCP inbox parity in the self-hosted-ONLY client: both the CLI (`inbox
// list`/`inbox read`) and the MCP tool (`list_inbound_emails`) read the SAME
// inbound mail over the /v1 API, so they must return equivalent data. (The
// previous local-SQLite "local mode" parity validated removed behavior.)

const { runInboxTool } = await import("../mcp/tools/inbox-impl.js");

let stub: V1Stub;

const PARITY_MESSAGE = {
  id: "parity-msg-1",
  direction: "inbound",
  from_addr: "sender@example.com",
  to_addrs: ["ops@example.com"],
  cc_addrs: [],
  subject: "Parity contract",
  body_text: "parity body content",
  body_html: null,
  status: "received",
  message_id: "<parity@example.com>",
  received_at: "2026-06-18T08:00:00.000Z",
  is_read: false,
  is_starred: false,
  labels: [],
  headers: {},
  created_at: "2026-06-18T08:00:01.000Z",
  updated_at: "2026-06-18T08:00:01.000Z",
};

beforeAll(async () => {
  stub = await startV1Stub();
});

afterAll(() => stub.stop());

beforeEach(async () => {
  await stub.seed({ messages: [PARITY_MESSAGE] });
  stub.applyEnv();
  resetMailDataSource();
});

afterEach(() => {
  resetMailDataSource();
  stub.clearEnv();
});

// Async spawn (never spawnSync): the out-of-process /v1 stub keeps serving while
// the CLI subprocess runs, so the event loop must not be blocked.
async function runCli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn({
    cmd: ["bun", "src/cli/index.tsx", "--json", ...args],
    cwd: process.cwd(),
    env: { ...process.env, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { code: proc.exitCode ?? -1, out: out.trim(), err: err.trim() };
}

async function mcpList(): Promise<Array<{ id: string; subject: string }>> {
  const result = await runInboxTool("list_inbound_emails", { limit: 25 });
  expect(result.isError).not.toBe(true);
  const parsed = JSON.parse(result.content[0]!.text) as { items: Array<{ id: string; subject: string }> };
  return parsed.items;
}

describe("inbox CLI<->MCP parity — self-hosted /v1", () => {
  it("CLI inbox list and MCP list_inbound_emails return equivalent /v1 data", async () => {
    const cli = await runCli(["inbox", "list", "--limit", "25"]);
    expect(cli.code).toBe(0);
    const cliRows = JSON.parse(cli.out) as Array<{ id: string; subject: string }>;

    const mcpRows = await mcpList();

    expect(cliRows.map((r) => r.subject)).toEqual(["Parity contract"]);
    expect(mcpRows.map((r) => r.subject)).toEqual(["Parity contract"]);
    expect(cliRows.map((r) => r.id)).toEqual(mcpRows.map((r) => r.id));
  }, 20_000);

  it("CLI inbox read returns the /v1 body content", async () => {
    const read = await runCli(["inbox", "read", PARITY_MESSAGE.id, "--keep-unread"]);
    expect(read.code).toBe(0);
    const detail = JSON.parse(read.out) as { id: string; subject: string; text_body: string };
    expect(detail).toMatchObject({ id: PARITY_MESSAGE.id, subject: "Parity contract" });
    expect(detail.text_body).toContain("parity body content");
  }, 20_000);
});
