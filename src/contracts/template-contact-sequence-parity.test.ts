import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  addStep,
  advanceEnrollment,
  closeDatabase,
  createProvider,
  createSequence,
  createTemplate,
  enroll,
  getAnalytics,
  getDatabase,
  getDueEnrollments,
  getLocalStats,
  getSequence,
  getTemplate,
  isContactSuppressed,
  listContacts,
  listEnrollments,
  listSandboxEmails,
  listSteps,
  listTemplates,
  renderTemplate,
  resetDatabase,
  suppressContact,
} from "../index.js";
import { startHttpServer } from "../mcp/http.js";

const tempDirs: string[] = [];
const servers: Array<ReturnType<typeof startHttpServer>> = [];

function isolatedEnv(dbPath: string, homePath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    EMAILS_DB_PATH: dbPath,
    HOME: homePath,
    NO_COLOR: "1",
  };
}

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return Bun.spawnSync({
    cmd: ["bun", "src/cli/index.tsx", ...args],
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function expectCliOk(result: ReturnType<typeof runCli>) {
  expect(result.exitCode).toBe(0);
  expect(new TextDecoder().decode(result.stderr)).toBe("");
}

async function callTool<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 10_000 });
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  return JSON.parse(text) as T;
}

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("template/contact/sequence parity", () => {
  it("covers the documented workflow through the CLI and validates via the library API", () => {
    closeDatabase();
    delete process.env["EMAILS_DB_PATH"];
    const dir = mkdtempSync(join(tmpdir(), "emails-parity-cli-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "emails.db");
    const env = isolatedEnv(dbPath, join(dir, "home"));

    expectCliOk(runCli(["--json", "provider", "add", "--name", "dev", "--type", "sandbox"], env));
    const providers = JSON.parse(new TextDecoder().decode(runCli(["--json", "provider", "list"], env).stdout)) as Array<{ id: string }>;
    const providerId = providers[0]!.id;
    expectCliOk(runCli(["--json", "template", "add", "welcome", "--subject", "Welcome {{name}}", "--text", "Hi {{name}}"], env));
    expectCliOk(runCli(["--json", "contact", "suppress", "user@example.com"], env));
    expectCliOk(runCli(["--json", "sequence", "create", "onboarding"], env));
    expectCliOk(runCli(["--json", "sequence", "step", "add", "onboarding", "--step", "1", "--delay", "0", "--template", "welcome"], env));
    expectCliOk(runCli(["--json", "sequence", "enroll", "onboarding", "user@example.com", "--provider", providerId], env));
    expectCliOk(runCli([
      "--json", "send",
      "--provider", providerId,
      "--from", "hello@example.com",
      "--to", "user@example.com",
      "--template", "welcome",
      "--vars", "{\"name\":\"Ada\"}",
      "--force",
    ], env));

    process.env["EMAILS_DB_PATH"] = dbPath;
    resetDatabase();
    expect(getTemplate("welcome")?.subject_template).toBe("Welcome {{name}}");
    expect(isContactSuppressed("user@example.com")).toBe(true);
    const sequence = getSequence("onboarding")!;
    expect(sequence.name).toBe("onboarding");
    expect(listSteps(sequence.id)).toHaveLength(1);
    expect(listEnrollments({ sequence_id: sequence.id })).toContainEqual(expect.objectContaining({
      contact_email: "user@example.com",
      provider_id: providerId,
    }));
    expect(listSandboxEmails(providerId, 10)[0]).toMatchObject({
      subject: "Welcome Ada",
      text_body: "Hi Ada",
    });
    expect(getLocalStats(providerId, "30d")).toBeTruthy();
    expect(getAnalytics(providerId, "30d")).toBeTruthy();
  }, 20_000);

  it("covers the same workflow through MCP tools and validates via the library API", async () => {
    const provider = createProvider({ name: "dev", type: "sandbox" });
    const server = startHttpServer({ port: 0, log: () => {} });
    servers.push(server);
    const client = new Client({ name: "emails-parity-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));

    try {
      await client.connect(transport, { timeout: 10_000 });
      await callTool(client, "add_template", {
        name: "welcome",
        subject_template: "Welcome {{name}}",
        text_template: "Hi {{name}}",
      });
      await callTool(client, "suppress_contact", { email: "user@example.com" });
      const sequence = await callTool<{ id: string }>(client, "create_sequence", { name: "onboarding" });
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
      await callTool(client, "send_email", {
        provider_id: provider.id,
        from: "hello@example.com",
        to: "user@example.com",
        template: "welcome",
        template_vars: { name: "Ada" },
      });

      expect(listTemplates()).toContainEqual(expect.objectContaining({ name: "welcome" }));
      expect(listContacts({ suppressed: true })).toContainEqual(expect.objectContaining({ email: "user@example.com" }));
      expect(listSteps(sequence.id)).toHaveLength(1);
      expect(listEnrollments({ sequence_id: sequence.id })).toContainEqual(expect.objectContaining({
        contact_email: "user@example.com",
        provider_id: provider.id,
      }));
      expect(listSandboxEmails(provider.id, 10)[0]).toMatchObject({
        subject: "Welcome Ada",
        text_body: "Hi Ada",
      });
    } finally {
      await client.close();
    }
  });

  it("covers the workflow through exported library functions including due-step processing", () => {
    const db = getDatabase();
    createTemplate({ name: "welcome", subject_template: "Welcome {{name}}", text_template: "Hi {{name}}" }, db);
    suppressContact("user@example.com", db);
    const seq = createSequence({ name: "onboarding" }, db);
    addStep({ sequence_id: seq.id, step_number: 1, delay_hours: 0, template_name: "welcome" }, db);
    const enrollment = enroll({ sequence_id: seq.id, contact_email: "user@example.com" }, db);

    expect(renderTemplate(getTemplate("welcome", db)!.subject_template, { name: "Ada" })).toBe("Welcome Ada");
    expect(isContactSuppressed("user@example.com", db)).toBe(true);
    expect(getDueEnrollments(db)).toContainEqual(expect.objectContaining({ id: enrollment.id }));
    expect(advanceEnrollment(enrollment.id, db)).toMatchObject({ status: "completed" });
  });
});
