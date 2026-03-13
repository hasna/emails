import { upsertEvent } from "../db/events.js";
import { getDatabase } from "../db/database.js";
import chalk from "chalk";

export interface WebhookEvent {
  provider_event_id: string;
  type: "delivered" | "bounced" | "complained" | "opened" | "clicked";
  recipient?: string;
  provider_message_id?: string;
  occurred_at: string;
  metadata?: Record<string, unknown>;
}

export function parseResendWebhook(body: any): WebhookEvent | null {
  const typeMap: Record<string, string> = {
    "email.delivered": "delivered",
    "email.bounced": "bounced",
    "email.complained": "complained",
    "email.opened": "opened",
    "email.clicked": "clicked",
  };
  const eventType = typeMap[body.type];
  if (!eventType) return null;
  return {
    provider_event_id: body.data?.email_id || crypto.randomUUID(),
    type: eventType as WebhookEvent["type"],
    recipient: Array.isArray(body.data?.to) ? body.data.to[0] : body.data?.to,
    provider_message_id: body.data?.email_id,
    occurred_at: body.data?.created_at || new Date().toISOString(),
    metadata: body.data || {},
  };
}

export function parseSesWebhook(body: any): WebhookEvent | null {
  const typeMap: Record<string, string> = {
    Delivery: "delivered",
    Bounce: "bounced",
    Complaint: "complained",
  };
  const eventType = typeMap[body.notificationType];
  if (!eventType) return null;
  const messageId = body.mail?.messageId;
  const recipients = body.mail?.destination || [];
  return {
    provider_event_id: body.mail?.messageId || crypto.randomUUID(),
    type: eventType as WebhookEvent["type"],
    recipient: recipients[0],
    provider_message_id: messageId,
    occurred_at: body.mail?.timestamp || new Date().toISOString(),
    metadata: body,
  };
}

function colorEventType(type: string): string {
  switch (type) {
    case "delivered": return chalk.green(type);
    case "bounced": return chalk.red(type);
    case "complained": return chalk.red(type);
    case "opened": return chalk.blue(type);
    case "clicked": return chalk.cyan(type);
    default: return type;
  }
}

export function createWebhookServer(port: number, providerId?: string) {
  const db = getDatabase();

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      let event: WebhookEvent | null = null;
      let body: any;

      try {
        body = await req.json();
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      if (url.pathname === "/webhook/resend") {
        event = parseResendWebhook(body);
      } else if (url.pathname === "/webhook/ses") {
        event = parseSesWebhook(body);
      } else {
        return new Response("Not found", { status: 404 });
      }

      if (!event) {
        return new Response("Unrecognized event type", { status: 200 });
      }

      // Determine provider ID — use provided one or try to find from path
      const pId = providerId || "webhook";

      try {
        upsertEvent(
          {
            provider_id: pId,
            provider_event_id: event.provider_event_id,
            type: event.type,
            recipient: event.recipient || null,
            metadata: event.metadata || {},
            occurred_at: event.occurred_at,
          },
          db,
        );
      } catch {
        // If provider_id doesn't exist in providers table, just log
      }

      const timestamp = new Date().toLocaleTimeString();
      console.log(
        `${chalk.gray(`[${timestamp}]`)} ${colorEventType(event.type)}  ${event.recipient || "unknown"}  ${chalk.dim(event.provider_event_id.slice(0, 12))}`,
      );

      return new Response("OK", { status: 200 });
    },
  });

  return server;
}
