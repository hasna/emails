import { google } from "googleapis";
import type { DnsRecord, DnsStatus, Provider, SendEmailOptions, Stats } from "../types/index.js";
import { ProviderConfigError } from "../types/index.js";
import type { ProviderAdapter, RemoteAddress, RemoteDomain, RemoteEvent } from "./interface.js";

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://mail.google.com/",
];

export class GmailAdapter implements ProviderAdapter {
  private providerId: string;
  private clientId: string;
  private clientSecret: string;
  private refreshToken: string;
  private accessToken: string;
  private tokenExpiry: Date;

  constructor(provider: Provider) {
    if (!provider.oauth_client_id) {
      throw new ProviderConfigError("Gmail provider requires oauth_client_id");
    }
    if (!provider.oauth_client_secret) {
      throw new ProviderConfigError("Gmail provider requires oauth_client_secret");
    }
    if (!provider.oauth_refresh_token) {
      throw new ProviderConfigError("Gmail provider requires oauth_refresh_token. Run 'emails provider auth <id>' to authenticate.");
    }

    this.providerId = provider.id;
    this.clientId = provider.oauth_client_id;
    this.clientSecret = provider.oauth_client_secret;
    this.refreshToken = provider.oauth_refresh_token;
    this.accessToken = provider.oauth_access_token ?? "";
    this.tokenExpiry = provider.oauth_token_expiry
      ? new Date(provider.oauth_token_expiry)
      : new Date(0);
  }

  private createOAuth2Client() {
    const oauth2Client = new google.auth.OAuth2(
      this.clientId,
      this.clientSecret,
    );
    oauth2Client.setCredentials({
      refresh_token: this.refreshToken,
      access_token: this.accessToken || undefined,
      expiry_date: this.tokenExpiry.getTime(),
      scope: GMAIL_SCOPES.join(" "),
    });
    return oauth2Client;
  }

  private getGmailClient() {
    const auth = this.createOAuth2Client();
    return google.gmail({ version: "v1", auth });
  }

  // ─── Domain management (not supported by Gmail) ───────────────────────────

  async listDomains(): Promise<RemoteDomain[]> {
    return [];
  }

  async getDnsRecords(_domain: string): Promise<DnsRecord[]> {
    return [];
  }

  async verifyDomain(_domain: string): Promise<{ dkim: DnsStatus; spf: DnsStatus; dmarc: DnsStatus }> {
    return { dkim: "pending", spf: "pending", dmarc: "pending" };
  }

  async addDomain(_domain: string): Promise<void> {
    throw new Error("Gmail does not support domain management");
  }

  // ─── Address management ───────────────────────────────────────────────────

  async listAddresses(): Promise<RemoteAddress[]> {
    const gmail = this.getGmailClient();
    const res = await gmail.users.getProfile({ userId: "me" });
    const email = res.data.emailAddress;
    if (!email) return [];
    return [{ email, verified: true }];
  }

  async addAddress(_email: string): Promise<void> {
    throw new Error("Gmail addresses are managed via OAuth — use 'emails provider auth <id>' to re-authenticate");
  }

  async verifyAddress(_email: string): Promise<boolean> {
    try {
      const gmail = this.getGmailClient();
      const res = await gmail.users.getProfile({ userId: "me" });
      return !!res.data.emailAddress;
    } catch {
      return false;
    }
  }

  // ─── Send email ───────────────────────────────────────────────────────────

  async sendEmail(opts: SendEmailOptions): Promise<string> {
    const gmail = this.getGmailClient();

    const toArr = Array.isArray(opts.to) ? opts.to : [opts.to];
    const raw = buildMimeMessage(opts, toArr);

    const encodedMessage = Buffer.from(raw).toString("base64url");

    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: encodedMessage },
    });

    return res.data.id ?? "";
  }

  // ─── Pull events ──────────────────────────────────────────────────────────

  async pullEvents(since?: string): Promise<RemoteEvent[]> {
    const gmail = this.getGmailClient();
    const events: RemoteEvent[] = [];

    try {
      // Build query: filter by date if provided
      let q = "label:SENT";
      if (since) {
        // Gmail uses epoch seconds in 'after:' queries
        const epochSeconds = Math.floor(new Date(since).getTime() / 1000);
        q += ` after:${epochSeconds}`;
      }

      const listRes = await gmail.users.messages.list({
        userId: "me",
        q,
        maxResults: 100,
      });

      const messages = listRes.data.messages ?? [];

      for (const msg of messages) {
        if (!msg.id) continue;

        try {
          const detail = await gmail.users.messages.get({
            userId: "me",
            id: msg.id,
            format: "metadata",
            metadataHeaders: ["To", "Subject", "Date"],
          });

          const labelIds = detail.data.labelIds ?? [];
          const internalDate = detail.data.internalDate
            ? new Date(parseInt(detail.data.internalDate, 10)).toISOString()
            : new Date().toISOString();

          // Map Gmail labels to event types
          const toHeader = detail.data.payload?.headers?.find(
            (h) => h.name?.toLowerCase() === "to",
          );
          const recipient = toHeader?.value ?? undefined;

          events.push({
            provider_event_id: msg.id,
            type: "delivered",
            recipient,
            occurred_at: internalDate,
            provider_message_id: msg.id,
            metadata: { labelIds },
          });
        } catch {
          // Skip messages we can't retrieve details for
        }
      }
    } catch {
      // Return empty events if listing fails
    }

    return events;
  }

  // ─── Stats ────────────────────────────────────────────────────────────────

  async getStats(period = "30d"): Promise<Stats> {
    const events = await this.pullEvents();
    return computeStats(this.providerId, period, events);
  }
}

// ─── MIME message builder ─────────────────────────────────────────────────────

function buildMimeMessage(opts: SendEmailOptions, toArr: string[]): string {
  const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const altBoundary = `alt_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  let msg = "";
  msg += `From: ${opts.from}\r\n`;
  msg += `To: ${toArr.join(", ")}\r\n`;

  if (opts.cc) {
    const ccArr = Array.isArray(opts.cc) ? opts.cc : [opts.cc];
    msg += `Cc: ${ccArr.join(", ")}\r\n`;
  }
  if (opts.bcc) {
    const bccArr = Array.isArray(opts.bcc) ? opts.bcc : [opts.bcc];
    msg += `Bcc: ${bccArr.join(", ")}\r\n`;
  }
  if (opts.reply_to) {
    msg += `Reply-To: ${opts.reply_to}\r\n`;
  }

  msg += `Subject: ${opts.subject}\r\n`;
  msg += `MIME-Version: 1.0\r\n`;

  const hasAttachments = opts.attachments && opts.attachments.length > 0;
  const hasHtml = !!opts.html;
  const hasText = !!opts.text;

  if (hasAttachments) {
    // multipart/mixed — body + attachments
    msg += `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`;
    msg += `--${boundary}\r\n`;

    if (hasHtml && hasText) {
      // nested multipart/alternative
      msg += `Content-Type: multipart/alternative; boundary="${altBoundary}"\r\n\r\n`;
      msg += `--${altBoundary}\r\n`;
      msg += `Content-Type: text/plain; charset="UTF-8"\r\n\r\n`;
      msg += `${opts.text}\r\n`;
      msg += `--${altBoundary}\r\n`;
      msg += `Content-Type: text/html; charset="UTF-8"\r\n\r\n`;
      msg += `${opts.html}\r\n`;
      msg += `--${altBoundary}--\r\n`;
    } else if (hasHtml) {
      msg += `Content-Type: text/html; charset="UTF-8"\r\n\r\n`;
      msg += `${opts.html}\r\n`;
    } else {
      msg += `Content-Type: text/plain; charset="UTF-8"\r\n\r\n`;
      msg += `${opts.text ?? ""}\r\n`;
    }

    for (const att of opts.attachments!) {
      msg += `--${boundary}\r\n`;
      msg += `Content-Type: ${att.content_type}; name="${att.filename}"\r\n`;
      msg += `Content-Disposition: attachment; filename="${att.filename}"\r\n`;
      msg += `Content-Transfer-Encoding: base64\r\n\r\n`;
      msg += `${att.content}\r\n`;
    }

    msg += `--${boundary}--`;
  } else if (hasHtml && hasText) {
    // multipart/alternative
    msg += `Content-Type: multipart/alternative; boundary="${altBoundary}"\r\n\r\n`;
    msg += `--${altBoundary}\r\n`;
    msg += `Content-Type: text/plain; charset="UTF-8"\r\n\r\n`;
    msg += `${opts.text}\r\n`;
    msg += `--${altBoundary}\r\n`;
    msg += `Content-Type: text/html; charset="UTF-8"\r\n\r\n`;
    msg += `${opts.html}\r\n`;
    msg += `--${altBoundary}--`;
  } else if (hasHtml) {
    msg += `Content-Type: text/html; charset="UTF-8"\r\n\r\n`;
    msg += opts.html!;
  } else {
    msg += `Content-Type: text/plain; charset="UTF-8"\r\n\r\n`;
    msg += opts.text ?? "";
  }

  return msg;
}

function computeStats(providerId: string, period: string, events: RemoteEvent[]): Stats {
  const now = Date.now();
  const days = parseInt(period.replace("d", ""), 10) || 30;
  const since = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

  const filtered = events.filter((e) => e.occurred_at >= since);

  const sent = filtered.length;
  const delivered = filtered.filter((e) => e.type === "delivered").length;
  const bounced = filtered.filter((e) => e.type === "bounced").length;
  const complained = filtered.filter((e) => e.type === "complained").length;
  const opened = filtered.filter((e) => e.type === "opened").length;
  const clicked = filtered.filter((e) => e.type === "clicked").length;

  return {
    provider_id: providerId,
    period,
    sent,
    delivered,
    bounced,
    complained,
    opened,
    clicked,
    delivery_rate: sent > 0 ? (delivered / sent) * 100 : 0,
    bounce_rate: sent > 0 ? (bounced / sent) * 100 : 0,
    open_rate: delivered > 0 ? (opened / delivered) * 100 : 0,
  };
}

// Export for testing
export { buildMimeMessage };
