import { parseResendWebhook, parseSesWebhook, verifyResendSignature, verifySnsStructure } from "./webhook-events.js";
import type { WebhookEvent } from "./webhook-events.js";
import { snsMessageAllowed, snsPolicyFromEnv, verifyAwsSnsSignature } from "./sns-signature.js";

export {
  parseResendWebhook,
  parseSesWebhook,
  verifyResendSignature,
  verifySnsStructure,
} from "./webhook-events.js";
export type { WebhookEvent } from "./webhook-events.js";

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

async function readBoundedWebhookBody(req: Request): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY_BYTES) throw new RangeError("webhook body too large");
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_WEBHOOK_BODY_BYTES) {
      await reader.cancel();
      throw new RangeError("webhook body too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function colorEventType(type: string, chalk: typeof import("chalk").default): string {
  switch (type) {
    case "delivered": return chalk.green(type);
    case "bounced": return chalk.red(type);
    case "complained": return chalk.red(type);
    case "opened": return chalk.blue(type);
    case "clicked": return chalk.cyan(type);
    default: return type;
  }
}

export function createWebhookServer(
  port: number,
  providerId?: string,
  webhookSecret?: string,
  deps: { verifySns?: (body: Record<string, unknown>) => Promise<boolean> } = {},
) {
  const maxRememberedWebhookIds = 10_000;
  const seenWebhookIds = new Set<string>();

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      let event: WebhookEvent | null = null;
      let bodyText: string;
      let body: any;

      try {
        bodyText = await readBoundedWebhookBody(req);
        body = JSON.parse(bodyText);
      } catch (error) {
        if (error instanceof RangeError) return new Response("Payload too large", { status: 413 });
        return new Response("Invalid JSON", { status: 400 });
      }

      if (url.pathname === "/webhook/resend") {
        if (!webhookSecret) return new Response("Resend webhook secret is not configured", { status: 503 });
        const webhookId = req.headers.get("svix-id");
        if (!webhookId) return new Response("Resend svix-id is required", { status: 400 });
        const headers: Record<string, string | null> = {
          "svix-id": webhookId,
          "svix-timestamp": req.headers.get("svix-timestamp"),
          "svix-signature": req.headers.get("svix-signature"),
        };
        const valid = await verifyResendSignature(bodyText, headers, webhookSecret).catch(() => false);
        if (!valid) return new Response("Invalid signature", { status: 401 });
        if (seenWebhookIds.has(webhookId)) return new Response("Webhook already processed", { status: 200 });
        event = parseResendWebhook(body, webhookId);
      } else if (url.pathname === "/webhook/ses") {
        if (!verifySnsStructure(body)) return new Response("Invalid SNS payload", { status: 400 });
        let policy;
        try { policy = snsPolicyFromEnv(); } catch { return new Response("SNS allowlist is not configured", { status: 503 }); }
        if (!snsMessageAllowed(body, policy)) return new Response("SNS topic or account is not allowed", { status: 401 });
        if (!(await (deps.verifySns ?? verifyAwsSnsSignature)(body).catch(() => false))) return new Response("Invalid SNS signature", { status: 401 });
        const snsMessageId = typeof body.MessageId === "string" ? body.MessageId : "";
        if (!snsMessageId) return new Response("SNS MessageId is required", { status: 400 });
        let inner: unknown = body;
        if (body.Type === "Notification" && typeof body.Message === "string") {
          try { inner = JSON.parse(body.Message); } catch { return new Response("Invalid SNS Message", { status: 400 }); }
        }
        event = parseSesWebhook(inner, snsMessageId);
      } else {
        return new Response("Not found", { status: 404 });
      }

      if (!event) {
        return new Response("Unrecognized event type", { status: 200 });
      }

      // Durable persistence must be associated with an explicit provider.
      if (!providerId) return new Response("A provider id is required for durable webhook persistence", { status: 503 });
      const pId = providerId;

      try {
        const [{ getDatabase }, { upsertEventWithResult }] = await Promise.all([
          import("../db/database.js"),
          import("../db/events.local.js"),
        ]);
        const result = upsertEventWithResult(
          {
            provider_id: pId,
            provider_event_id: event.provider_event_id,
            type: event.type,
            recipient: event.recipient || null,
            metadata: event.metadata || {},
            occurred_at: event.occurred_at,
          },
          getDatabase(),
        );
        if (result.created) {
          const webhookId = req.headers.get("svix-id") ?? event.provider_event_id;
          seenWebhookIds.add(webhookId);
          if (seenWebhookIds.size > maxRememberedWebhookIds) {
            const oldest = seenWebhookIds.values().next().value;
            if (oldest) seenWebhookIds.delete(oldest);
          }
        }
      } catch {
        return new Response("Webhook persistence failed", { status: 500 });
      }

      const timestamp = new Date().toLocaleTimeString();
      const { default: chalk } = await import("chalk");
      console.log(
        `${chalk.gray(`[${timestamp}]`)} ${colorEventType(event.type, chalk)}  ${event.recipient || "unknown"}  ${chalk.dim(event.provider_event_id.slice(0, 12))}`,
      );

      return new Response("OK", { status: 200 });
    },
  });

  return server;
}
