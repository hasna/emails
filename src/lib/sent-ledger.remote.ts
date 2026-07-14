import type { Email, SendEmailOptions } from "../types/index.js";
import type { EmailThreading } from "../db/threads.js";

// The sent-mail ledger records outbound messages (and their content + threading)
// into the local SQLite `emails`/`email_content`/`threads` tables. In the
// self-hosted client the operator's server records sent mail when a message is
// POSTed to the authenticated `/v1` send endpoint — the thin client keeps no
// local ledger — so these entrypoints preserve their signatures/return types and
// fail loud.

export async function createSentEmailLedger(
  _providerId: string,
  _opts: SendEmailOptions,
  _providerMessageId?: string,
): Promise<Email> {
  throw new Error(
    "createSentEmailLedger is not available in the self-hosted client; sent mail is recorded on the self-hosted server when you send via /v1.",
  );
}

export async function storeSentEmailContent(
  _emailId: string,
  _content: { html?: string; text?: string; headers?: Record<string, string> },
): Promise<void> {
  throw new Error(
    "storeSentEmailContent is not available in the self-hosted client; sent mail content is stored on the self-hosted server.",
  );
}

export async function setSentEmailThreading(
  _emailId: string,
  _threading: Partial<EmailThreading>,
): Promise<void> {
  throw new Error(
    "setSentEmailThreading is not available in the self-hosted client; sent mail threading is recorded on the self-hosted server.",
  );
}
