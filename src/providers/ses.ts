import {
  SESv2Client,
  CreateEmailIdentityCommand,
  GetEmailIdentityCommand,
  ListEmailIdentitiesCommand,
  SendEmailCommand,
  BatchGetMetricDataCommand,
  PutEmailIdentityMailFromAttributesCommand,
} from "@aws-sdk/client-sesv2";
import {
  SESClient as SESClassicClient,
  GetIdentityVerificationAttributesCommand,
  VerifyDomainDkimCommand,
  VerifyDomainIdentityCommand,
} from "@aws-sdk/client-ses";
import type { DnsRecord, DnsStatus, Provider, SendEmailOptions, Stats } from "../types/index.js";
import { ProviderConfigError } from "../types/index.js";
import type { ProviderAdapter, RemoteAddress, RemoteDomain, RemoteEvent } from "./interface.js";

export interface SesStaticCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * Where the AWS credentials for a SES provider come from.
 *
 * `provider`  — the provider row itself carries an access key AND a secret key.
 *               Those are used EXCLUSIVELY: they are never mixed with ambient
 *               `AWS_*` values, because half-a-key-pair from each source
 *               silently signs against the wrong account (the shape of the
 *               2026-07-25 incident, where a provider added with the correct
 *               credentials still sent through the deployment IAM role).
 * `ambient`   — no provider credentials, but a complete static `AWS_*` pair is
 *               present in the environment.
 * `chain`     — nothing explicit: defer to the AWS SDK default chain (EC2/ECS
 *               task role, SSO, shared config, …).
 */
export type SesCredentialSource = "provider" | "ambient" | "chain";

export interface SesCredentialResolution {
  source: SesCredentialSource;
  credentials?: SesStaticCredentials;
}

/**
 * Resolve which credentials a SES client must sign with. Exported so both the
 * adapter and `provider add/update` validation agree on ONE rule — validating
 * against a different identity than the one that will send is exactly how a
 * provider could report "credentials valid" while sending from another account.
 */
export function resolveSesCredentials(
  provider: Pick<Provider, "access_key" | "secret_key">,
  env: NodeJS.ProcessEnv = process.env,
): SesCredentialResolution {
  const providerAccessKey = provider.access_key?.trim() || "";
  const providerSecretKey = provider.secret_key?.trim() || "";
  const envAccessKey = env["AWS_ACCESS_KEY_ID"]?.trim() || "";
  const envSecretKey = env["AWS_SECRET_ACCESS_KEY"]?.trim() || "";
  if (providerAccessKey || providerSecretKey) {
    if (!providerAccessKey || !providerSecretKey) {
      // One exception to the both-or-neither rule, and only one: the provider
      // names the SAME access key id the environment already holds a complete
      // pair for. That is not a mixed identity — it is the identity the
      // operator asked for, spelled twice — and rows shaped like this predate
      // the rule (pre-1.3.0 `provider add --access-key` without a secret relied
      // on the environment). Anything else still refuses: completing half a
      // pair from a DIFFERENT identity is what signs against the wrong account.
      if (providerAccessKey && !providerSecretKey && envAccessKey === providerAccessKey && envSecretKey) {
        const sessionToken = env["AWS_SESSION_TOKEN"]?.trim() || "";
        return {
          source: "ambient",
          credentials: {
            accessKeyId: envAccessKey,
            secretAccessKey: envSecretKey,
            ...(sessionToken ? { sessionToken } : {}),
          },
        };
      }
      throw new ProviderConfigError(
        "SES provider credentials are incomplete: an access key and a secret key must be supplied together. " +
          "Partial provider credentials are never completed from the environment, because that would sign with a mixed identity. " +
          "Supply both with `emails provider update <id> --access-key … --secret-key …`, or clear both to fall back to the deployment role.",
      );
    }
    return { source: "provider", credentials: { accessKeyId: providerAccessKey, secretAccessKey: providerSecretKey } };
  }
  if (envAccessKey && envSecretKey) {
    const sessionToken = env["AWS_SESSION_TOKEN"]?.trim() || "";
    return {
      source: "ambient",
      credentials: {
        accessKeyId: envAccessKey,
        secretAccessKey: envSecretKey,
        ...(sessionToken ? { sessionToken } : {}),
      },
    };
  }
  return { source: "chain" };
}

export class SESAdapter implements ProviderAdapter {
  private client: SESv2Client;
  private classicClient: SESClassicClient;
  private providerId: string;
  /** Which identity this adapter signs with — surfaced for diagnostics/logs. */
  readonly credentialSource: SesCredentialSource;
  private configurationSetName: string | undefined;

  constructor(provider: Provider) {
    const region = provider.region || process.env["AWS_REGION"] || "us-east-1";

    if (!region) {
      throw new ProviderConfigError("SES provider requires a region");
    }

    const resolved = resolveSesCredentials(provider);
    const clientConfig: ConstructorParameters<typeof SESv2Client>[0] = { region };
    const classicClientConfig: ConstructorParameters<typeof SESClassicClient>[0] = { region };

    if (resolved.credentials) {
      clientConfig.credentials = { ...resolved.credentials };
      classicClientConfig.credentials = { ...resolved.credentials };
    }

    this.client = new SESv2Client(clientConfig);
    this.classicClient = new SESClassicClient(classicClientConfig);
    this.providerId = provider.id;
    this.credentialSource = resolved.source;
    this.configurationSetName = process.env["EMAILS_SES_CONFIGURATION_SET"]?.trim() || undefined;
  }

  async listDomains(): Promise<RemoteDomain[]> {
    const result = await this.client.send(
      new ListEmailIdentitiesCommand({}),
    );

    const domains: RemoteDomain[] = [];
    for (const identity of result.EmailIdentities ?? []) {
      if (!identity.IdentityName) continue;
      // Filter to domains only (exclude email addresses which contain @)
      if (identity.IdentityName.includes("@")) continue;
      try {
        const detail = await this.client.send(
          new GetEmailIdentityCommand({ EmailIdentity: identity.IdentityName }),
        );
        const dkimStatus = this.mapDkimStatus(detail.DkimAttributes?.Status);
        domains.push({
          domain: identity.IdentityName,
          dkim_status: dkimStatus,
          spf_status: this.mapIdentityStatus(detail.VerificationStatus, detail.VerifiedForSendingStatus),
          dmarc_status: "pending",
        });
      } catch {
        domains.push({
          domain: identity.IdentityName,
          dkim_status: "pending",
          spf_status: "pending",
          dmarc_status: "pending",
        });
      }
    }
    return domains;
  }

  async getDnsRecords(domain: string): Promise<DnsRecord[]> {
    const records: DnsRecord[] = [];

    const identityRecord = await this.getDomainIdentityDnsRecord(domain);
    if (identityRecord) records.push(identityRecord);

    try {
      const detail = await this.client.send(
        new GetEmailIdentityCommand({ EmailIdentity: domain }),
      );

      // DKIM CNAME records
      for (const token of detail.DkimAttributes?.Tokens ?? []) {
        records.push({
          type: "CNAME",
          name: `${token}._domainkey.${domain}`,
          value: `${token}.dkim.amazonses.com`,
          purpose: "DKIM",
        });
      }
    } catch {
      // Domain not registered yet — provide template records
    }

    // SPF record
    records.push({
      type: "TXT",
      name: domain,
      value: "v=spf1 include:amazonses.com ~all",
      purpose: "SPF",
    });

    // DMARC record
    records.push({
      type: "TXT",
      name: `_dmarc.${domain}`,
      value: `v=DMARC1; p=none; rua=mailto:dmarc@${domain}`,
      purpose: "DMARC",
    });

    return records;
  }

  async verifyDomain(domain: string): Promise<{ dkim: DnsStatus; spf: DnsStatus; dmarc: DnsStatus }> {
    try {
      const detail = await this.client.send(
        new GetEmailIdentityCommand({ EmailIdentity: domain }),
      );
      const dkimStatus = this.mapDkimStatus(detail.DkimAttributes?.Status);
      return {
        dkim: dkimStatus,
        spf: this.mapIdentityStatus(detail.VerificationStatus, detail.VerifiedForSendingStatus),
        dmarc: "pending",
      };
    } catch {
      return { dkim: "pending", spf: "pending", dmarc: "pending" };
    }
  }

  async reinitiateDomainVerification(domain: string): Promise<DnsRecord[]> {
    const identity = await this.classicClient.send(
      new VerifyDomainIdentityCommand({ Domain: domain }),
    );
    const dkim = await this.classicClient.send(
      new VerifyDomainDkimCommand({ Domain: domain }),
    );

    const records: DnsRecord[] = [];
    if (identity.VerificationToken) {
      records.push(this.createIdentityDnsRecord(domain, identity.VerificationToken));
    }
    for (const token of dkim.DkimTokens ?? []) {
      records.push({
        type: "CNAME",
        name: `${token}._domainkey.${domain}`,
        value: `${token}.dkim.amazonses.com`,
        purpose: "DKIM",
      });
    }
    return records;
  }

  async addDomain(domain: string): Promise<void> {
    try {
      // EasyDKIM: create the identity WITHOUT DkimSigningAttributes so SES
      // generates and rotates the DKIM keys itself. (Passing an empty
      // DomainSigningPrivateKey is rejected with a validation error.)
      await this.client.send(
        new CreateEmailIdentityCommand({ EmailIdentity: domain }),
      );
    } catch (err: unknown) {
      // If identity already exists, that's fine
      if (err instanceof Error && err.name === "AlreadyExistsException") return;
      throw err;
    }
  }

  /**
   * Set a custom MAIL FROM domain (improves SPF/DMARC alignment). Defaults to
   * `mail.<domain>`. Requires the MAIL FROM MX + SPF records to be published.
   */
  async setMailFrom(domain: string, mailFromDomain?: string): Promise<string> {
    const mailFrom = mailFromDomain ?? `mail.${domain}`;
    await this.client.send(
      new PutEmailIdentityMailFromAttributesCommand({
        EmailIdentity: domain,
        MailFromDomain: mailFrom,
        BehaviorOnMxFailure: "REJECT_MESSAGE",
      }),
    );
    return mailFrom;
  }

  private async getDomainIdentityDnsRecord(domain: string): Promise<DnsRecord | null> {
    try {
      const result = await this.classicClient.send(
        new GetIdentityVerificationAttributesCommand({ Identities: [domain] }),
      );
      const attributes = result.VerificationAttributes ?? {};
      const match = attributes[domain] ?? Object.entries(attributes)
        .find(([identity]) => identity.toLowerCase() === domain.toLowerCase())?.[1];
      const token = match?.VerificationToken?.trim();
      return token ? this.createIdentityDnsRecord(domain, token) : null;
    } catch {
      return null;
    }
  }

  private createIdentityDnsRecord(domain: string, token: string): DnsRecord {
    return {
      type: "TXT",
      name: `_amazonses.${domain}`,
      value: token,
      purpose: "SES_IDENTITY",
    };
  }

  async listAddresses(): Promise<RemoteAddress[]> {
    const result = await this.client.send(
      new ListEmailIdentitiesCommand({}),
    );

    const addresses: RemoteAddress[] = [];
    for (const identity of result.EmailIdentities ?? []) {
      if (!identity.IdentityName) continue;
      // Filter to email addresses only (exclude domains which don't contain @)
      if (!identity.IdentityName.includes("@")) continue;
      try {
        const detail = await this.client.send(
          new GetEmailIdentityCommand({ EmailIdentity: identity.IdentityName }),
        );
        addresses.push({
          email: identity.IdentityName,
          verified: detail.VerifiedForSendingStatus ?? false,
        });
      } catch {
        addresses.push({ email: identity.IdentityName, verified: false });
      }
    }
    return addresses;
  }

  async addAddress(email: string): Promise<void> {
    try {
      await this.client.send(
        new CreateEmailIdentityCommand({ EmailIdentity: email }),
      );
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AlreadyExistsException") return;
      throw err;
    }
  }

  async verifyAddress(email: string): Promise<boolean> {
    try {
      const detail = await this.client.send(
        new GetEmailIdentityCommand({ EmailIdentity: email }),
      );
      return detail.VerifiedForSendingStatus ?? false;
    } catch {
      return false;
    }
  }

  async sendEmail(opts: SendEmailOptions): Promise<string> {
    assertSafeEmailHeaders(opts);
    const toArr = Array.isArray(opts.to) ? opts.to : [opts.to];
    const ccArr = opts.cc ? (Array.isArray(opts.cc) ? opts.cc : [opts.cc]) : [];
    const bccArr = opts.bcc ? (Array.isArray(opts.bcc) ? opts.bcc : [opts.bcc]) : [];

    // Build extra headers (List-Unsubscribe, custom headers)
    const extraHeaders: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.unsubscribe_url) {
      extraHeaders["List-Unsubscribe"] = `<${opts.unsubscribe_url}>`;
      extraHeaders["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
    }
    const hasCustomHeaders = Object.keys(extraHeaders).length > 0;

    if (opts.attachments && opts.attachments.length > 0 || hasCustomHeaders) {
      // Build raw MIME message for attachments or custom headers
      const rawMessage = buildRawMime({ ...opts, headers: { ...opts.headers, ...extraHeaders } });
      const result = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: opts.from,
          // SESv2 SendEmail with Raw content still needs explicit recipients —
          // omitting Destination means the message is accepted but not delivered.
          Destination: {
            ToAddresses: toArr,
            CcAddresses: ccArr.length > 0 ? ccArr : undefined,
            BccAddresses: bccArr.length > 0 ? bccArr : undefined,
          },
          Content: {
            Raw: { Data: Buffer.from(rawMessage) },
          },
          ...(this.configurationSetName ? { ConfigurationSetName: this.configurationSetName } : {}),
        }),
      );
      return result.MessageId ?? "";
    }

    const result = await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: opts.from,
        Destination: {
          ToAddresses: toArr,
          CcAddresses: ccArr.length > 0 ? ccArr : undefined,
          BccAddresses: bccArr.length > 0 ? bccArr : undefined,
        },
        ReplyToAddresses: opts.reply_to ? [opts.reply_to] : undefined,
        Content: {
          Simple: {
            Subject: { Data: opts.subject, Charset: "UTF-8" },
            Body: {
              ...(opts.html ? { Html: { Data: opts.html, Charset: "UTF-8" } } : {}),
              ...(opts.text ? { Text: { Data: opts.text, Charset: "UTF-8" } } : {}),
            },
          },
        },
        EmailTags: opts.tags
          ? Object.entries(opts.tags).map(([Name, Value]) => ({ Name, Value }))
          : undefined,
        ...(this.configurationSetName ? { ConfigurationSetName: this.configurationSetName } : {}),
      }),
    );

    return result.MessageId ?? "";
  }

  async pullEvents(_since?: string): Promise<RemoteEvent[]> {
    // SES doesn't have a direct events list API — stats are aggregate only
    // Return empty; real webhook events come via SNS → webhook endpoint
    return [];
  }

  async getStats(period = "30d"): Promise<Stats> {
    const days = parseInt(period.replace("d", ""), 10) || 30;
    const endDate = new Date();
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    try {
      const result = await this.client.send(
        new BatchGetMetricDataCommand({
          Queries: [
            { Id: "sent", Namespace: "VDM", Metric: "SEND", StartDate: startDate, EndDate: endDate },
            { Id: "delivered", Namespace: "VDM", Metric: "DELIVERY", StartDate: startDate, EndDate: endDate },
            { Id: "bounced", Namespace: "VDM", Metric: "PERMANENT_BOUNCE", StartDate: startDate, EndDate: endDate },
            { Id: "complained", Namespace: "VDM", Metric: "COMPLAINT", StartDate: startDate, EndDate: endDate },
            { Id: "opened", Namespace: "VDM", Metric: "OPEN", StartDate: startDate, EndDate: endDate },
            { Id: "clicked", Namespace: "VDM", Metric: "CLICK", StartDate: startDate, EndDate: endDate },
          ],
        }),
      );

      const sum = (id: string): number => {
        const entry = result.Results?.find((r) => r.Id === id);
        return (entry?.Values ?? []).reduce((a: number, b: number) => a + b, 0);
      };

      const sent = sum("sent");
      const delivered = sum("delivered");
      const bounced = sum("bounced");
      const complained = sum("complained");
      const opened = sum("opened");
      const clicked = sum("clicked");

      return {
        provider_id: this.providerId,
        period,
        sent,
        delivered,
        bounced,
        complained,
        opened,
        clicked,
        delivery_rate: sent > 0 ? (delivered / sent) * 100 : 0,
        bounce_rate: sent > 0 ? (bounced / sent) * 100 : 0,
        open_rate: sent > 0 ? (opened / sent) * 100 : 0,
      };
    } catch {
      return {
        provider_id: this.providerId,
        period,
        sent: 0,
        delivered: 0,
        bounced: 0,
        complained: 0,
        opened: 0,
        clicked: 0,
        delivery_rate: 0,
        bounce_rate: 0,
        open_rate: 0,
      };
    }
  }

  private mapDkimStatus(status?: string): DnsStatus {
    if (status === "SUCCESS") return "verified";
    if (status === "FAILED" || status === "TEMPORARY_FAILURE") return "failed";
    return "pending";
  }

  private mapIdentityStatus(status?: string, verified?: boolean): DnsStatus {
    if (verified) return "verified";
    if (status === "SUCCESS") return "verified";
    if (status === "FAILED" || status === "TEMPORARY_FAILURE") return "failed";
    return "pending";
  }
}

const MIME_TOKEN_RE = /^[A-Za-z0-9!#$&^_.+~-]+$/;
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const RESERVED_RAW_HEADERS = new Set([
  "from", "to", "cc", "bcc", "subject", "date", "mime-version",
  "content-type", "content-disposition", "content-transfer-encoding", "reply-to",
]);

function assertHeaderValue(label: string, value: string): void {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
  if (/[\x00-\x1F\x7F]/.test(value)) throw new Error(`${label} contains forbidden control characters`);
  if (!isWellFormedUnicode(value)) throw new Error(`${label} contains non-well-formed Unicode`);
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
      index++;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

function assertContentType(value: string): void {
  const [type, subtype, ...extra] = value.split("/");
  if (extra.length > 0 || !type || !subtype || !MIME_TOKEN_RE.test(type) || !MIME_TOKEN_RE.test(subtype)) {
    throw new Error("attachment content_type must be a safe type/subtype token");
  }
}

function assertSafeEmailHeaders(opts: SendEmailOptions): void {
  assertHeaderValue("from", opts.from);
  for (const [label, values] of [
    ["to", Array.isArray(opts.to) ? opts.to : [opts.to]],
    ["cc", opts.cc ? (Array.isArray(opts.cc) ? opts.cc : [opts.cc]) : []],
    ["bcc", opts.bcc ? (Array.isArray(opts.bcc) ? opts.bcc : [opts.bcc]) : []],
  ] as const) {
    for (const value of values) assertHeaderValue(label, value);
  }
  assertHeaderValue("subject", opts.subject);
  if (opts.reply_to) assertHeaderValue("reply_to", opts.reply_to);
  if (opts.unsubscribe_url) assertHeaderValue("unsubscribe_url", opts.unsubscribe_url);
  for (const [name, value] of Object.entries(opts.headers ?? {})) {
    if (!HEADER_NAME_RE.test(name) || RESERVED_RAW_HEADERS.has(name.toLowerCase())) {
      throw new Error(`unsafe custom email header name: ${name}`);
    }
    assertHeaderValue(`header ${name}`, value);
  }
  for (const attachment of opts.attachments ?? []) {
    assertHeaderValue("attachment filename", attachment.filename);
    if (attachment.filename.length > 255) throw new Error("attachment filename must be at most 255 characters");
    assertContentType(attachment.content_type);
    if (!attachment.content || attachment.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.content)) {
      throw new Error("attachment content must be canonical base64");
    }
    const decoded = Buffer.from(attachment.content, "base64");
    if (decoded.toString("base64") !== attachment.content) throw new Error("attachment content must be canonical base64");
  }
}

function encodeHeaderText(value: string): string {
  return /^[\x20-\x7E]+$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function filenameParameters(filename: string): { fallback: string; encoded: string } {
  const leaf = filename.split(/[\\/]/).pop() || "attachment";
  const fallback = leaf
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  const encoded = encodeURIComponent(leaf).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return { fallback, encoded };
}

function wrapBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

function buildRawMime(opts: SendEmailOptions): string {
  const toArr = Array.isArray(opts.to) ? opts.to : [opts.to];
  const rnd = () => crypto.randomUUID().replace(/-/g, "");
  // Fully independent boundaries (no prefix collision — a nested boundary that
  // is a prefix of its parent makes MIME parsers ambiguous and gets rejected).
  const mixedB = `mixed_${rnd()}`;
  const altB = `alt_${rnd()}`;
  const hasAttachments = (opts.attachments?.length ?? 0) > 0;

  const headerLines: string[] = [
    `From: ${opts.from}`,
    `To: ${toArr.join(", ")}`,
    ...(opts.cc ? [`Cc: ${(Array.isArray(opts.cc) ? opts.cc : [opts.cc]).join(", ")}`] : []),
    `Subject: ${encodeHeaderText(opts.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    ...(opts.reply_to ? [`Reply-To: ${opts.reply_to}`] : []),
    ...(opts.headers ? Object.entries(opts.headers).map(([k, v]) => `${k}: ${v}`) : []),
  ];

  // The body: an alternative part (text + html) when both exist, else a single
  // part. Wrapped in multipart/mixed ONLY when there are attachments.
  const altParts: string[] = [];
  if (opts.text) altParts.push(`--${altB}`, `Content-Type: text/plain; charset=UTF-8`, "", opts.text, "");
  if (opts.html) altParts.push(`--${altB}`, `Content-Type: text/html; charset=UTF-8`, "", opts.html, "");

  function bodyBlock(): { ctype: string; lines: string[] } {
    if (opts.text && opts.html) {
      return { ctype: `multipart/alternative; boundary="${altB}"`, lines: [...altParts, `--${altB}--`] };
    }
    if (opts.html) return { ctype: `text/html; charset=UTF-8`, lines: [opts.html] };
    return { ctype: `text/plain; charset=UTF-8`, lines: [opts.text ?? ""] };
  }

  const lines: string[] = [...headerLines];
  if (!hasAttachments) {
    const b = bodyBlock();
    lines.push(`Content-Type: ${b.ctype}`, "", ...b.lines);
    return lines.join("\r\n");
  }

  // With attachments: multipart/mixed { body, attachments... }
  lines.push(`Content-Type: multipart/mixed; boundary="${mixedB}"`, "");
  const b = bodyBlock();
  lines.push(`--${mixedB}`, `Content-Type: ${b.ctype}`, "", ...b.lines, "");
  for (const a of opts.attachments ?? []) {
    const filename = filenameParameters(a.filename);
    lines.push(`--${mixedB}`,
      `Content-Type: ${a.content_type}; name="${filename.fallback}"; name*=UTF-8''${filename.encoded}`,
      `Content-Disposition: attachment; filename="${filename.fallback}"; filename*=UTF-8''${filename.encoded}`,
      `Content-Transfer-Encoding: base64`, "", wrapBase64(a.content), "");
  }
  lines.push(`--${mixedB}--`);
  return lines.join("\r\n");
}
