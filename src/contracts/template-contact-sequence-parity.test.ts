import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  addStep,
  advanceEnrollment,
  createProvider,
  createSequence,
  createTemplate,
  enroll,
  getDueEnrollments,
  getSequence,
  getTemplate,
  isContactSuppressed,
  listContacts,
  listEnrollments,
  listSteps,
  listTemplates,
  renderTemplate,
  suppressContact,
} from "../index.js";
import { startHttpServer } from "../mcp/http.js";
import { mcpTestRequestInit, startTestMcpHttpServer } from "../test-support/mcp-http.js";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";

// Template/contact/sequence parity in the self-hosted-ONLY client: the CLI, the
// MCP tools, and the exported library functions all operate on the SAME entities
// over the /v1 API, so a workflow driven through any surface is observable via
// the others. Outbound send + sandbox capture + delivery stats/analytics moved
// server-side (they are loud stubs) and are not part of this client-side parity
// contract anymore.

let stub: V1Stub;
const servers: Array<ReturnType<typeof startHttpServer>> = [];

beforeAll(async () => {
  // `openapi: true`: the collapsed sequences family reaches `/v1` through the real
  // HTTP store, which reads the published contract before filtered reads and writes.
  stub = await startV1Stub({ openapi: true });
});

afterAll(() => stub.stop());

beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  stub.clearEnv();
});

async function runCli(args: string[]) {
  const proc = Bun.spawn({
    cmd: ["bun", "src/cli/index.tsx", ...args],
    cwd: process.cwd(),
    env: { ...process.env, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { code: proc.exitCode ?? -1, out: out.trim(), err: err.trim() };
}

async function expectCliOk(promise: ReturnType<typeof runCli>) {
  const result = await promise;
  expect(result.code).toBe(0);
  return result;
}

async function callTool<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 10_000 });
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  return JSON.parse(text) as T;
}

describe("template/contact/sequence parity", () => {
  it("covers the workflow through the CLI and validates via the library API over /v1", async () => {
    await expectCliOk(runCli(["--json", "provider", "add", "--name", "dev", "--type", "sandbox"]));
    const providersOut = await expectCliOk(runCli(["--json", "provider", "list"]));
    const providers = JSON.parse(providersOut.out) as Array<{ id: string }>;
    const providerId = providers[0]!.id;

    await expectCliOk(runCli(["--json", "template", "add", "welcome", "--subject", "Welcome {{name}}", "--text", "Hi {{name}}"]));
    await expectCliOk(runCli(["--json", "contact", "suppress", "user@example.com"]));
    await expectCliOk(runCli(["--json", "sequence", "create", "onboarding"]));
    await expectCliOk(runCli(["--json", "sequence", "step", "add", "onboarding", "--step", "1", "--delay", "0", "--template", "welcome"]));
    await expectCliOk(runCli(["--json", "sequence", "enroll", "onboarding", "user@example.com", "--provider", providerId]));

    expect((await getTemplate("welcome"))?.subject_template).toBe("Welcome {{name}}");
    expect(await isContactSuppressed("user@example.com")).toBe(true);
    const sequence = (await getSequence("onboarding"))!;
    expect(sequence.name).toBe("onboarding");
    expect(await listSteps(sequence.id)).toHaveLength(1);
    expect(await listEnrollments({ sequence_id: sequence.id })).toContainEqual(expect.objectContaining({
      contact_email: "user@example.com",
      provider_id: providerId,
    }));
  }, 30_000);

  it("covers the API-backed MCP tools and confirms sub-ledger writes are server-owned", async () => {
    const provider = createProvider({ name: "dev", type: "sandbox" });
    const server = startTestMcpHttpServer();
    servers.push(server);
    const client = new Client({ name: "emails-parity-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), mcpTestRequestInit());

    try {
      await client.connect(transport, { timeout: 10_000 });
      // These MCP tools are API-backed in self_hosted mode and route to /v1.
      await callTool(client, "add_template", {
        name: "welcome",
        subject_template: "Welcome {{name}}",
        text_template: "Hi {{name}}",
      });
      await callTool(client, "suppress_contact", { email: "user@example.com" });
      const sequence = await callTool<{ id: string }>(client, "create_sequence", { name: "onboarding" });

      expect(await listTemplates()).toContainEqual(expect.objectContaining({ name: "welcome" }));
      expect(await listContacts({ suppressed: true })).toContainEqual(expect.objectContaining({ email: "user@example.com" }));
      expect((await getSequence("onboarding"))?.id).toBe(sequence.id);

      // Sequence steps and enrollments are `/v1/sequence-steps` and
      // `/v1/sequence-enrollments`, so writing them over MCP is IN parity: the row
      // the tool creates is the same row the exported library functions read back.
      // These two calls used to be refused with "disabled in self_hosted API-only
      // mode" while `emails sequence step add` / `emails sequence enroll` wrote the
      // very same rows over the very same route — the guard was the only refusal.
      await callTool(client, "add_sequence_step", {
        sequence_id: sequence.id,
        step_number: 1,
        delay_hours: 0,
        template_name: "welcome",
      });
      await callTool(client, "enroll_contact", {
        sequence_id: sequence.id,
        contact_email: "user@example.com",
        provider_id: provider.id,
      });

      expect(await listSteps(sequence.id)).toContainEqual(expect.objectContaining({ step_number: 1, template_name: "welcome" }));
      expect(await listEnrollments({ sequence_id: sequence.id })).toContainEqual(expect.objectContaining({
        contact_email: "user@example.com",
        provider_id: provider.id,
        status: "active",
      }));
    } finally {
      await client.close();
    }
  }, 30_000);

  it("covers the workflow through exported library functions including due-step processing", async () => {
    await createTemplate({ name: "welcome", subject_template: "Welcome {{name}}", text_template: "Hi {{name}}" });
    // The collapsed contacts family is async too — an un-awaited suppress here leaked
    // its rejection into the NEXT test file when the stub env was already torn down.
    await suppressContact("user@example.com");
    // The collapsed sequences family is async; every call below is awaited.
    const seq = await createSequence({ name: "onboarding" });
    await addStep({ sequence_id: seq.id, step_number: 1, delay_hours: 0, template_name: "welcome" });
    const enrollment = await enroll({ sequence_id: seq.id, contact_email: "user@example.com" });

    expect(renderTemplate((await getTemplate("welcome"))!.subject_template, { name: "Ada" })).toBe("Welcome Ada");
    expect(await isContactSuppressed("user@example.com")).toBe(true);
    expect(await getDueEnrollments()).toContainEqual(expect.objectContaining({ id: enrollment.id }));
    expect(await advanceEnrollment(enrollment.id)).toMatchObject({ status: "completed" });
  });
});
