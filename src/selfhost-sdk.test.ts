import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  SELF_HOSTED_RESPONSE_COMPONENTS,
  SELF_HOSTED_RESPONSE_CONTRACTS,
} from "./lib/self-hosted-response-contracts.generated.js";
import { SelfHostedWireResponseError } from "./lib/self-hosted-wire.js";
import { ApiError, EmailsSelfHostClient } from "./selfhost.js";

type JsonSchema = Record<string, unknown>;
const RESPONSE_SECRET_MARKER = "credential-like-response-body-must-not-leak";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function schemaSample(schema: JsonSchema): unknown {
  const ref = schema["$ref"];
  if (typeof ref === "string") {
    const name = ref.slice("#/components/schemas/".length);
    const component = SELF_HOSTED_RESPONSE_COMPONENTS[name];
    if (!isRecord(component)) throw new Error(`missing response fixture component ${name}`);
    return schemaSample(component);
  }
  if (Array.isArray(schema["enum"]) && schema["enum"].length > 0) return schema["enum"][0];
  if (Array.isArray(schema["oneOf"]) && isRecord(schema["oneOf"].at(-1))) {
    // Prefer the last branch: additive compatibility unions commonly put a
    // narrower legacy shape last, avoiding overlap with a richer first branch.
    return schemaSample(schema["oneOf"].at(-1) as JsonSchema);
  }
  if (Array.isArray(schema["anyOf"]) && isRecord(schema["anyOf"][0])) {
    return schemaSample(schema["anyOf"][0]);
  }
  if (Array.isArray(schema["allOf"])) {
    return schema["allOf"].reduce<Record<string, unknown>>((merged, branch) => {
      const sample = isRecord(branch) ? schemaSample(branch) : undefined;
      return isRecord(sample) ? { ...merged, ...sample } : merged;
    }, {});
  }
  const type = schema["type"];
  if (
    type === "object"
    || Array.isArray(schema["required"])
    || isRecord(schema["properties"])
  ) {
    const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
    const required = Array.isArray(schema["required"]) ? schema["required"] : [];
    return required.reduce<Record<string, unknown>>((sample, field) => {
      if (typeof field === "string" && isRecord(properties[field])) {
        sample[field] = schemaSample(properties[field]);
      }
      return sample;
    }, {});
  }
  if (type === "array") return [];
  if (type === "boolean") return false;
  if (type === "integer" || type === "number") return schema["minimum"] ?? 0;
  if (type === "string") {
    if (schema["format"] === "date-time") return "2026-07-26T10:00:00.000Z";
    if (schema["format"] === "uuid") return "12345678-1234-4234-8234-123456789abc";
    if (schema["format"] === "email") return "fixture@example.test";
    const pattern = typeof schema["pattern"] === "string" ? schema["pattern"] : "";
    if (pattern.includes("{64}")) return "a".repeat(64);
    const minLength = typeof schema["minLength"] === "number" ? schema["minLength"] : 1;
    return "x".repeat(Math.max(1, minLength));
  }
  return null;
}

function contractMatchesPath(template: string, pathname: string): boolean {
  const source = template
    .split(/(\{[^}]+\})/g)
    .map((part) => part.startsWith("{")
      ? "[^/]+"
      : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("");
  return new RegExp(`^${source}$`).test(pathname);
}

function validResponseFor(request: Request): Response {
  const pathname = new URL(request.url).pathname;
  const contract = SELF_HOSTED_RESPONSE_CONTRACTS.find((candidate) =>
    candidate.method === request.method
    && contractMatchesPath(candidate.path, pathname));
  if (!contract) throw new Error(`missing generated response fixture for ${request.method} ${pathname}`);
  if (contract.schema !== null && !isRecord(contract.schema)) {
    throw new Error(`invalid generated response fixture for ${request.method} ${pathname}`);
  }
  const body = contract.schema === null ? undefined : JSON.stringify(schemaSample(contract.schema));
  return new Response(body, {
    status: contract.status,
    headers: { "Content-Type": "application/json" },
  });
}

function okFetch(capture: (request: Request) => void): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    capture(request);
    return validResponseFor(request);
  }) as typeof fetch;
}

describe("generated self-hosted SDK identity contract", () => {
  it("sends a user session as Authorization Bearer and does not duplicate credentials", async () => {
    let request: Request | null = null;
    const client = new EmailsSelfHostClient({
      baseUrl: "https://emails.example.test",
      apiKey: "api-key-placeholder",
      bearerToken: "session-placeholder",
      fetch: okFetch((value) => { request = value; }),
    });

    await client.listTenants();
    expect(request?.headers.get("authorization")).toBe("Bearer session-placeholder");
    expect(request?.headers.has("x-api-key")).toBe(false);
  });

  it("keeps tenant API-key authentication and exposes the formalized identity surface", async () => {
    let request: Request | null = null;
    const client = new EmailsSelfHostClient({
      baseUrl: "https://emails.example.test",
      apiKey: "api-key-placeholder",
      fetch: okFetch((value) => { request = value; }),
    });

    await client.getCurrentPrincipal();
    expect(request?.headers.get("x-api-key")).toBe("api-key-placeholder");
    expect(request?.headers.has("authorization")).toBe(false);
    expect(typeof client.signUp).toBe("function");
    expect(typeof client.bootstrapPrimarySuperAdmin).toBe("function");
    expect(typeof client.listEmailIdentities).toBe("function");
    expect(typeof client.updateMembership).toBe("function");
    expect(typeof client.createTenantKey).toBe("function");
  });

  it("generates a send payload where attachment filename and content_type remain optional", async () => {
    let request: Request | null = null;
    const client = new EmailsSelfHostClient({
      baseUrl: "https://emails.example.test",
      apiKey: "api-key-placeholder",
      fetch: okFetch((value) => { request = value; }),
    });

    await client.sendMessage({
      from: "sender@example.test",
      to: ["recipient@example.test"],
      subject: "subject",
      idempotency_key: "tenant-scoped-key",
      attachments: [{ content: "ZmFrZQ==" }],
    });
    expect(await request?.json()).toEqual({
      from: "sender@example.test",
      to: ["recipient@example.test"],
      subject: "subject",
      idempotency_key: "tenant-scoped-key",
      attachments: [{ content: "ZmFrZQ==" }],
    });
  });

  it("serializes the bounded attachment byte limit on the typed SDK operation", async () => {
    let request: Request | null = null;
    const client = new EmailsSelfHostClient({
      baseUrl: "https://emails.example.test",
      apiKey: "api-key-placeholder",
      fetch: okFetch((value) => { request = value; }),
    });

    await client.getMessageAttachment("message/one", 2, { max_bytes: 4096 });
    expect(request?.url).toBe("https://emails.example.test/v1/messages/message%2Fone/attachments/2?max_bytes=4096");
    expect(request?.headers.get("x-api-key")).toBe("api-key-placeholder");
  });

  it("forces redirect rejection so custom authentication is never forwarded", async () => {
    let redirect: RequestRedirect | undefined;
    const client = new EmailsSelfHostClient({
      baseUrl: "https://emails.example.test",
      apiKey: "api-key-placeholder",
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        redirect = init?.redirect;
        return validResponseFor(new Request(_input, init));
      }) as typeof fetch,
    });

    await client.getHealth({ redirect: "follow" });
    expect(redirect).toBe("error");
  });

  it("keeps send-intent keys in JSON bodies for typed lookup and cancellation", async () => {
    const requests: Request[] = [];
    const client = new EmailsSelfHostClient({
      baseUrl: "https://emails.example.test",
      apiKey: "api-key-placeholder",
      fetch: okFetch((value) => { requests.push(value); }),
    });

    await client.lookupSendIntent({ idempotency_key: "tenant-scoped-key" });
    await client.cancelSendIntent({ idempotency_key: "tenant-scoped-key" });

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/v1/messages/send-intents/lookup",
      "/v1/messages/send-intents/cancel",
    ]);
    expect(requests.every((request) => new URL(request.url).search === "")).toBe(true);
    expect(await requests[0]!.json()).toEqual({ idempotency_key: "tenant-scoped-key" });
    expect(await requests[1]!.json()).toEqual({ idempotency_key: "tenant-scoped-key" });
  });

  it("generates the bounded recovery-visible send-state union", () => {
    const generated = readFileSync(new URL("./selfhost.ts", import.meta.url), "utf8");
    expect(generated).toContain(
      `export interface SendIntentMessage { "id": string; "send_state": "none" | "pending" | "blocked" | "cancelled" | "sending" | "sent" | "failed" | "uncertain" }`,
    );
  });

  it("unions every successful send status and oneOf branch in the declaration", () => {
    const generated = readFileSync(new URL("./selfhost.ts", import.meta.url), "utf8");
    const signature = generated.match(
      /async sendMessage\([^]*?\): Promise<([^]*?)> \{\n\s+return this\.request/,
    )?.[1] ?? "";
    expect(signature).toContain(`"idempotent_replay": true`);
    expect(signature).toContain(`"in_progress": true`);
    expect(signature).toContain(`"sent": true`);
    expect(signature).toContain(`"provider_message_id": string`);
  });

  it("preserves nullable refs and route-specific auth schemas in generated declarations", () => {
    const generated = readFileSync(new URL("./selfhost.ts", import.meta.url), "utf8");
    expect(generated).toMatch(
      /bootstrapPrimarySuperAdmin[^]*?Promise<\{ "created": boolean; "user": User; "tenant": Tenant \| null \}>/,
    );
    const principalSignature = generated.match(
      /async getCurrentPrincipal[^\n]+/,
    )?.[0] ?? "";
    expect(principalSignature).toContain(`"principal_type": "user"`);
    expect(principalSignature).toContain(`"global_role"?: "user" | "super_admin"`);
    expect(principalSignature).toContain(`}) | null`);
    expect(principalSignature).not.toContain(`"user": User | null`);
    expect(generated).toMatch(
      /verifySendKey[^]*?Promise<\{ "valid": boolean; "authorized": boolean; "key": SendKey \| null \}>/,
    );
  });

  it("throws a wire-contract error for malformed raw non-2xx JSON before redaction", async () => {
    const client = new EmailsSelfHostClient({
      baseUrl: "https://emails.example.test",
      apiKey: "api-key-placeholder",
      fetch: (async () => new Response(JSON.stringify({
        error: RESPONSE_SECRET_MARKER,
        reason: "provider_outcome_uncertain",
        sent: null,
        retry_safe: true,
      }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch,
    });
    await expect(client.sendMessage({
      from: "sender@example.test",
      to: ["recipient@example.test"],
      subject: "subject",
      idempotency_key: "tenant-scoped-key",
    })).rejects.toBeInstanceOf(SelfHostedWireResponseError);
  });

  it("generates and sends the discriminated reviewed dry-run proof for attachment repair apply", async () => {
    let request: Request | null = null;
    const client = new EmailsSelfHostClient({
      baseUrl: "https://emails.example.test",
      apiKey: "api-key-placeholder",
      fetch: okFetch((value) => { request = value; }),
    });
    const generated = readFileSync(new URL("./selfhost.ts", import.meta.url), "utf8");
    expect(generated).toContain(`"apply"?: false`);
    expect(generated).toContain(`"apply": true`);
    expect(generated).toContain(`"reviewed_dry_run_id": string`);
    expect(generated).toContain(`"reviewed_dry_run_result_sha256": string`);

    await client.createOrResumeAttachmentRepair({
      idempotency_key: "apply-key",
      apply: true,
      entries: [{
        object_key: "source/one",
        recipients: ["recipient@example.test"],
        canary_message_ids: ["message-1"],
      }],
      reviewed_dry_run_id: "22222222-2222-4222-8222-222222222222",
      reviewed_dry_run_result_sha256: "a".repeat(64),
    });

    expect(await request?.json()).toEqual({
      idempotency_key: "apply-key",
      apply: true,
      entries: [{
        object_key: "source/one",
        recipients: ["recipient@example.test"],
        canary_message_ids: ["message-1"],
      }],
      reviewed_dry_run_id: "22222222-2222-4222-8222-222222222222",
      reviewed_dry_run_result_sha256: "a".repeat(64),
    });
  });

  for (const status of [409, 502]) {
    it(`preserves the exact message id and send state in ${status} send errors`, async () => {
      const exactMessageId = "12345678-1234-4234-8234-123456789abc";
      const requests: Request[] = [];
      const client = new EmailsSelfHostClient({
        baseUrl: "https://emails.example.test",
        apiKey: "api-key-placeholder",
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          requests.push(request);
          if (request.method === "GET") {
            const message = schemaSample(
              SELF_HOSTED_RESPONSE_COMPONENTS["Message"] as JsonSchema,
            ) as Record<string, unknown>;
            return new Response(JSON.stringify({
              message: { ...message, id: exactMessageId },
            }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          const message = status === 409
            ? {
              id: exactMessageId,
              send_state: "sending",
            }
            : {
              ...(schemaSample(
                SELF_HOSTED_RESPONSE_COMPONENTS["Message"] as JsonSchema,
              ) as Record<string, unknown>),
              id: exactMessageId,
              send_state: "uncertain",
            };
          return new Response(JSON.stringify({
            error: "reconciliation required",
            reason: status === 502 ? "provider_outcome_uncertain" : undefined,
            sent: status === 502 ? null : undefined,
            retry_safe: false,
            reconciliation_required: status === 502 ? true : undefined,
            message,
          }), {
            status,
            headers: { "Content-Type": "application/json" },
          });
        }) as typeof fetch,
      });

      let projection: { id: string; send_state: string } | undefined;
      let rawBody: unknown;
      try {
        await client.sendMessage({
          from: "sender@example.test",
          to: ["recipient@example.test"],
          subject: "subject",
          idempotency_key: "tenant-scoped-key",
        });
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        projection = (error as ApiError).sendIntentMessage;
        rawBody = (error as ApiError).body;
      }
      expect(projection).toEqual({
        id: exactMessageId,
        send_state: status === 409 ? "sending" : "uncertain",
      });
      expect(rawBody).toEqual({
        ...(status === 502 ? {
          reason: "provider_outcome_uncertain",
          sent: null,
          reconciliation_required: true,
        } : {}),
        retry_safe: false,
        message: {
          id: exactMessageId,
          send_state: status === 409 ? "sending" : "uncertain",
        },
      });
      expect(JSON.stringify(rawBody)).not.toContain("sender@example.test");

      await client.getMessage(projection!.id);
      expect(new URL(requests[1]!.url).pathname).toBe(`/v1/messages/${exactMessageId}`);
      expect(requests[1]!.method).toBe("GET");
    });
  }

  it("preserves pending intents returned by a failed policy-state transition", async () => {
    const exactMessageId = "12345678-1234-4234-8234-123456789abc";
    const client = new EmailsSelfHostClient({
      baseUrl: "https://emails.example.test",
      apiKey: "api-key-placeholder",
      fetch: (async () => new Response(JSON.stringify({
        error: "policy transition failed",
        retry_safe: false,
        message: { id: exactMessageId, send_state: "pending" },
      }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch,
    });
    try {
      await client.sendMessage({
        from: "sender@example.test",
        to: ["recipient@example.test"],
        subject: "subject",
        idempotency_key: "tenant-scoped-key",
      });
      throw new Error("expected ApiError");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).sendIntentMessage).toEqual({
        id: exactMessageId,
        send_state: "pending",
      });
    }
  });

  it("preserves failed intents returned by a provider rejection", async () => {
    const exactMessageId = "12345678-1234-4234-8234-123456789abc";
    const client = new EmailsSelfHostClient({
      baseUrl: "https://emails.example.test",
      apiKey: "api-key-placeholder",
      fetch: (async () => new Response(JSON.stringify({
        error: "provider rejected message",
        retry_safe: false,
        message: { id: exactMessageId, send_state: "failed" },
      }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch,
    });
    try {
      await client.sendMessage({
        from: "sender@example.test",
        to: ["recipient@example.test"],
        subject: "subject",
        idempotency_key: "tenant-scoped-key",
      });
      throw new Error("expected ApiError");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).sendIntentMessage).toEqual({
        id: exactMessageId,
        send_state: "failed",
      });
    }
  });

  it("preserves legacy none-state keyed intents for reconciliation", async () => {
    const exactMessageId = "12345678-1234-4234-8234-123456789abc";
    const client = new EmailsSelfHostClient({
      baseUrl: "https://emails.example.test",
      apiKey: "api-key-placeholder",
      fetch: (async () => new Response(JSON.stringify({
        error: "durable send-intent ledger rows cannot be deleted",
        retry_safe: false,
        message: { id: exactMessageId, send_state: "none" },
      }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch,
    });
    try {
      await client.deleteMessage(exactMessageId);
      throw new Error("expected ApiError");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).sendIntentMessage).toEqual({
        id: exactMessageId,
        send_state: "none",
      });
    }
  });

  it("accepts declared routine CRUD and auth errors before projecting safe fields", async () => {
    const cases: Array<{
      status: number;
      body: Record<string, unknown>;
      invoke(client: EmailsSelfHostClient): Promise<unknown>;
      projected: Record<string, unknown> | undefined;
    }> = [
      {
        status: 404,
        body: { error: "contacts not found" },
        invoke: (client) => client.getResourceContacts("missing-contact"),
        projected: undefined,
      },
      {
        status: 429,
        body: {
          error: "too many requests",
          reason: "rate_limited",
          retry_after: 30,
        },
        invoke: (client) => client.logIn({
          email: "user@example.test",
          password: "password-placeholder",
        }),
        projected: { reason: "rate_limited", retry_after: 30 },
      },
      {
        status: 400,
        body: { error: "token is required" },
        invoke: (client) => client.resetPassword({
          token: "",
          new_password: "password-placeholder",
        }),
        projected: undefined,
      },
      {
        status: 400,
        body: { error: "password must be at least 8 characters" },
        invoke: (client) => client.bootstrapOwner({
          email: "owner@example.test",
          password: "short",
        }),
        projected: undefined,
      },
      {
        status: 403,
        body: {
          error: "bootstrap requires an api key",
          reason: "apikey_required",
        },
        invoke: (client) => client.bootstrapOwner({
          email: "owner@example.test",
          password: "password-placeholder",
        }),
        projected: { reason: "apikey_required" },
      },
    ];

    for (const item of cases) {
      const client = new EmailsSelfHostClient({
        baseUrl: "https://emails.example.test",
        apiKey: "api-key-placeholder",
        fetch: (async () => new Response(JSON.stringify(item.body), {
          status: item.status,
          headers: { "Content-Type": "application/json" },
        })) as typeof fetch,
      });
      try {
        await item.invoke(client);
        throw new Error("expected ApiError");
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(item.status);
        expect((error as ApiError).body).toEqual(item.projected);
        expect(JSON.stringify((error as ApiError).body) ?? "").not.toContain("password-placeholder");
      }
    }
  });

  it("still fails closed for malformed declared errors and undeclared statuses", async () => {
    for (const [status, body] of [
      [404, { error: "wrong resource" }],
      [418, { error: "contacts not found" }],
    ] as const) {
      const client = new EmailsSelfHostClient({
        baseUrl: "https://emails.example.test",
        apiKey: "api-key-placeholder",
        fetch: (async () => new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        })) as typeof fetch,
      });
      await expect(client.getResourceContacts("missing-contact"))
        .rejects.toBeInstanceOf(SelfHostedWireResponseError);
    }
  });

  it("rejects non-canonical ids and non-recovery states from error projections", async () => {
    const bodies: Array<[Record<string, unknown>, typeof ApiError | typeof SelfHostedWireResponseError]> = [
      [{
        error: "reconciliation required",
        retry_safe: false,
        message: { id: "../../not-a-message", send_state: "cancelled" },
      }, ApiError],
      [{
        error: "reconciliation required",
        retry_safe: false,
        message: {
          id: "12345678-1234-4234-8234-123456789abc",
          send_state: "attacker_state",
        },
      }, SelfHostedWireResponseError],
    ];
    for (const [body, expectedError] of bodies) {
      const client = new EmailsSelfHostClient({
        baseUrl: "https://emails.example.test",
        apiKey: "api-key-placeholder",
        fetch: (async () => new Response(JSON.stringify(body), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        })) as typeof fetch,
      });
      try {
        await client.sendMessage({
          from: "sender@example.test",
          to: ["recipient@example.test"],
          subject: "subject",
          idempotency_key: "tenant-scoped-key",
        });
        throw new Error("expected ApiError");
      } catch (error) {
        expect(error).toBeInstanceOf(expectedError);
        if (error instanceof ApiError) {
          expect(error.sendIntentMessage).toBeUndefined();
        }
      }
    }
  });
});
