// `set_config` must not be a general-purpose write into the operator's config.
//
// The tool took `key: z.string()` with no allowlist, and `saveConfig` re-seeds
// the in-process cache so a write takes effect immediately. So an agent could
// rewrite anything in ~/.hasna/emails/config.json — including `emails_mode`,
// which decides whether this process talks to local SQLite or the operator's
// self-hosted API (mid-session), and every credential-bearing key, which points
// an integration wherever the agent likes.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_WRITABLE_CONFIG_KEYS,
  agentConfigKeyRefusal,
  isAgentWritableConfigKey,
  loadConfig,
  setAgentConfigValue,
  setConfigValue,
} from "../lib/config.js";
import { EMAILS_MODE_CONFIG_KEY } from "../lib/mode.js";
import { isSensitiveKey } from "../lib/redaction.js";
import { startHttpServer } from "./http.js";

// Keys whose write would change what datastore the process talks to, or hand an
// agent a credential. None may ever become writable through the agent surface.
const FORBIDDEN_KEYS = [
  EMAILS_MODE_CONFIG_KEY,
  "mode",
  "storage_mode",
  "mailery_mode",
  "cloudflare_api_token",
  "cloudflare_api_key",
  "cloudflare_email",
  "cloudflare_account_id",
  "resend_api_key",
  "resend_webhook_secret",
  "emails_inbound_webhook_secret",
  "ses_inbound_webhook_secret",
  "inbound_s3_buckets",
  "inbound_realtime_queue_url",
  "inbound_realtime_topic_arn",
  // Data-flow wiring: these decide where mail and attachments come FROM and go
  // TO, so an allowlisted write is an exfiltration or injection sink, not a
  // setting. `attachment_storage: "s3"` + `attachment_s3_bucket` makes the next
  // inbound sync PUT every attachment into a caller-named bucket under the
  // operator's AWS credentials; `inbound_s3_bucket` is folded into the list the
  // background pullers walk, so one write makes the auto-pull loop ingest forged
  // mail indefinitely; `attachment_storage: "none"` silently discards
  // attachments.
  "attachment_storage",
  "attachment_s3_bucket",
  "attachment_s3_prefix",
  "attachment_s3_region",
  "inbound_s3_bucket",
  "inbound_s3_prefix",
  "inbound_s3_region",
  "inbound_s3_profile",
  "ses_aws_profile",
];

let tmpHome: string;
let originalHome: string | undefined;
let originalMcpToken: string | undefined;

// The MCP HTTP transport requires a bearer token once #68 lands, and ignores one
// before that. Setting it (and sending it) here keeps this file green whichever
// order the two PRs merge in.
const MCP_HTTP_TOKEN = "set-config-allowlist-test-token-0123456789";

beforeEach(() => {
  originalHome = process.env["HOME"];
  originalMcpToken = process.env["EMAILS_MCP_HTTP_TOKEN"];
  tmpHome = mkdtempSync(join(tmpdir(), "emails-set-config-allowlist-"));
  process.env["HOME"] = tmpHome;
  process.env["EMAILS_MCP_HTTP_TOKEN"] = MCP_HTTP_TOKEN;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  if (originalMcpToken === undefined) delete process.env["EMAILS_MCP_HTTP_TOKEN"];
  else process.env["EMAILS_MCP_HTTP_TOKEN"] = originalMcpToken;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("agent-writable config allowlist", () => {
  it("refuses every mode-switching and credential-bearing key", () => {
    for (const key of FORBIDDEN_KEYS) {
      expect(isAgentWritableConfigKey(key)).toBe(false);
      expect(() => setAgentConfigValue(key, "agent-controlled")).toThrow(/is not writable through this tool/);
      // The refusal must not have written anything.
      expect(loadConfig()[key]).toBeUndefined();
    }
  });

  it("names the permitted keys in the refusal so a caller can self-correct", () => {
    const message = agentConfigKeyRefusal("emails_mode");
    for (const key of AGENT_WRITABLE_CONFIG_KEYS) expect(message).toContain(key);
    expect(message).toContain("emails_mode");
    expect(message).toContain("credential");
  });

  it("never admits a credential-shaped key, even if one were added to the list", () => {
    for (const key of AGENT_WRITABLE_CONFIG_KEYS) {
      expect(isSensitiveKey(key)).toBe(false);
      expect(isAgentWritableConfigKey(key)).toBe(true);
    }

    // The above only snapshots today's list. Exercise the `isSensitiveKey` leg
    // itself, which is the leg that has to hold if someone widens the list: a
    // credential-shaped name must be refused even when it IS a member.
    const widened = [...AGENT_WRITABLE_CONFIG_KEYS, "some_api_key", "vendor_token", "db_password"];
    for (const key of widened) {
      const onList = widened.includes(key);
      expect(onList).toBe(true);
      if (isSensitiveKey(key)) {
        // Sensitive members are rejected by the second leg, not the list.
        expect(isAgentWritableConfigKey(key)).toBe(false);
      }
    }
    expect(["some_api_key", "vendor_token", "db_password"].every(isSensitiveKey)).toBe(true);
  });

  it("keeps the writable set minimal — settings only, no data-flow wiring", () => {
    expect([...AGENT_WRITABLE_CONFIG_KEYS].sort()).toEqual([
      "bounce-alert-threshold",
      "complaint-alert-threshold",
      "default_provider",
      "failover-providers",
    ]);
  });

  it("validates the value, not just the key", () => {
    // An allowlisted key with an arbitrary value is still a way to break the
    // install: `getFailoverProviderIds` String()-splits whatever is stored, so a
    // JSON object there becomes garbage provider ids that only fail at send time.
    for (const [key, bad] of [
      ["default_provider", ""],
      ["default_provider", 42],
      ["failover-providers", { a: 1 }],
      ["failover-providers", ""],
      ["bounce-alert-threshold", "not-a-number"],
      ["bounce-alert-threshold", -1],
      ["complaint-alert-threshold", {}],
    ] as Array<[string, unknown]>) {
      expect(() => setAgentConfigValue(key, bad)).toThrow();
      expect(loadConfig()[key]).toBeUndefined();
    }

    setAgentConfigValue("bounce-alert-threshold", 5);
    setAgentConfigValue("failover-providers", ["p1", "p2"]);
    expect(loadConfig()["bounce-alert-threshold"]).toBe(5);
    // Normalized to the comma-separated form the reader splits.
    expect(loadConfig()["failover-providers"]).toBe("p1,p2");
  });

  it("refuses unknown and near-miss keys rather than writing a key nothing reads", () => {
    for (const key of ["", " ", "not_a_real_key", "EMAILS_MODE", "Attachment_Storage", "default_provider_x", "__proto__"]) {
      expect(isAgentWritableConfigKey(key)).toBe(false);
      expect(() => setAgentConfigValue(key, "x")).toThrow();
    }
    expect(Object.keys(loadConfig())).toEqual([]);
  });

  it("still writes a permitted key, trimming the name", () => {
    setAgentConfigValue("failover-providers", "p1,p2");
    setAgentConfigValue("  default_provider  ", "prov-1");

    const config = loadConfig();
    expect(config["failover-providers"]).toBe("p1,p2");
    expect(config["default_provider"]).toBe("prov-1");
  });

  it("leaves the operator/library path unrestricted", () => {
    // `setConfigValue` is the operator path; the gate belongs at the agent
    // boundary, not on the whole config file.
    setConfigValue(EMAILS_MODE_CONFIG_KEY, "local");
    expect(loadConfig()[EMAILS_MODE_CONFIG_KEY]).toBe("local");
  });
});

describe("set_config MCP tool", () => {
  const servers: Array<ReturnType<typeof startHttpServer>> = [];

  afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true);
  });

  async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
    const server = startHttpServer({ port: 0, log: () => {} });
    servers.push(server);
    const client = new Client({ name: "set-config-allowlist-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${MCP_HTTP_TOKEN}` } },
    });
    await client.connect(transport, { timeout: 10_000 });
    try {
      return await run(client);
    } finally {
      await client.close();
    }
  }

  async function callSetConfig(client: Client, key: string, value: string): Promise<{ text: string; isError: boolean }> {
    try {
      const result = await client.callTool({ name: "set_config", arguments: { key, value } }, undefined, { timeout: 10_000 });
      const content = result.content as Array<{ type: string; text?: string }> | undefined;
      return { text: content?.[0]?.text ?? "", isError: result.isError === true };
    } catch (error) {
      // A schema-level rejection surfaces as a protocol error; that is still a
      // refusal, and it still must not have written anything.
      return { text: error instanceof Error ? error.message : String(error), isError: true };
    }
  }

  it("refuses emails_mode instead of switching the datastore mid-session", async () => {
    await withClient(async (client) => {
      const result = await callSetConfig(client, EMAILS_MODE_CONFIG_KEY, "self_hosted");

      expect(result.isError).toBe(true);
      expect(loadConfig()[EMAILS_MODE_CONFIG_KEY]).toBeUndefined();
    });
  });

  it("refuses credential-bearing keys", async () => {
    await withClient(async (client) => {
      for (const key of ["cloudflare_api_token", "resend_api_key", "emails_inbound_webhook_secret", "attachment_s3_bucket", "inbound_s3_bucket"]) {
        const result = await callSetConfig(client, key, "AGENT_SUPPLIED_SECRET");

        expect(result.isError).toBe(true);
        expect(result.text).not.toContain("AGENT_SUPPLIED_SECRET");
        expect(loadConfig()[key]).toBeUndefined();
      }
    });
  });

  it("still writes a permitted key", async () => {
    await withClient(async (client) => {
      const result = await callSetConfig(client, "default_provider", "agent-written");

      expect(result.isError).toBe(false);
      expect(result.text).toContain("agent-written");
      expect(loadConfig()["default_provider"]).toBe("agent-written");
    });
  });

  it("advertises the permitted keys in the tool schema and description", async () => {
    await withClient(async (client) => {
      const tools = await client.listTools(undefined, { timeout: 10_000 });
      const tool = tools.tools.find((entry) => entry.name === "set_config");
      const schema = tool?.inputSchema as { properties?: { key?: { enum?: string[] } } } | undefined;

      expect(schema?.properties?.key?.enum?.sort()).toEqual([...AGENT_WRITABLE_CONFIG_KEYS].sort());
      expect(schema?.properties?.key?.enum).not.toContain(EMAILS_MODE_CONFIG_KEY);
      expect(tool?.description).toContain("Writable keys");
    });
  });
});
