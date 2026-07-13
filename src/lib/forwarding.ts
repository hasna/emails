import type { SendResult } from "./send.js";
import type { SendEmailOptions } from "../types/index.js";

export interface ForwardingRunOptions {
  providerId?: string;
  fromAddress?: string;
  limit?: number;
  backfill?: boolean;
  /** @internal for testing — inject a send implementation. */
  send?: (providerId: string, opts: SendEmailOptions) => Promise<SendResult>;
}

export interface ForwardingRunItem {
  rule_id: string;
  inbound_email_id: string;
  target_address: string;
  status: "sent" | "failed" | "skipped";
  sent_email_id: string | null;
  error: string | null;
}

export interface ForwardingRunResult {
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
  items: ForwardingRunItem[];
}

// App-level forwarding reads local inbound message bodies, sends copies through
// the local provider adapters, and writes a local sent-mail ledger + forwarding
// delivery records. All of that is server-side in the self-hosted client, so
// this stub preserves the signature/return type and fails loud. Forwarding runs
// on an API-backed self-hosted route.
export async function processForwardingRules(_opts: ForwardingRunOptions = {}): Promise<ForwardingRunResult> {
  throw new Error(
    "processForwardingRules is not available in the self-hosted client; app-level forwarding runs on the self-hosted server.",
  );
}
