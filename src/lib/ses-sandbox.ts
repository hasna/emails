/**
 * SES sandbox / production-access helper.
 *
 * SES starts in the sandbox (send only to verified identities, 200/day, 1/sec).
 * `getSandboxStatus` reads the current account state; `requestProductionAccess`
 * submits a production-access request via PutAccountDetails (AWS reviews ~24h).
 *
 * The AWS client is injected (minimal `send` surface) so this is unit-testable
 * without real credentials.
 */

import {
  SESv2Client,
  GetAccountCommand,
  PutAccountDetailsCommand,
  type MailType,
} from "@aws-sdk/client-sesv2";

export interface SesAccountStatus {
  productionAccess: boolean;
  sendingEnabled: boolean;
  max24HourSend?: number;
  maxSendRate?: number;
  sentLast24Hours?: number;
}

export interface SesClientLike {
  send: (cmd: unknown) => Promise<any>;
}

function makeClient(region: string, accessKeyId?: string, secretAccessKey?: string): SESv2Client {
  const credentials = accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined;
  return new SESv2Client({ region, credentials });
}

export interface SesSandboxOptions {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  client?: SesClientLike;
}

export async function getSandboxStatus(opts: SesSandboxOptions = {}): Promise<SesAccountStatus> {
  const client = opts.client ?? makeClient(opts.region ?? "us-east-1", opts.accessKeyId, opts.secretAccessKey);
  const res = await client.send(new GetAccountCommand({}));
  return {
    productionAccess: !!res.ProductionAccessEnabled,
    sendingEnabled: !!res.SendingEnabled,
    max24HourSend: res.SendQuota?.Max24HourSend,
    maxSendRate: res.SendQuota?.MaxSendRate,
    sentLast24Hours: res.SendQuota?.SentLast24Hours,
  };
}

export interface ProductionAccessRequest {
  websiteUrl: string;
  useCaseDescription: string;
  mailType?: MailType; // "TRANSACTIONAL" | "MARKETING"
  additionalContactEmailAddresses?: string[];
  contactLanguage?: "EN" | "JA";
}

export async function requestProductionAccess(
  req: ProductionAccessRequest,
  opts: SesSandboxOptions = {},
): Promise<{ submitted: boolean }> {
  const client = opts.client ?? makeClient(opts.region ?? "us-east-1", opts.accessKeyId, opts.secretAccessKey);
  await client.send(
    new PutAccountDetailsCommand({
      ProductionAccessEnabled: true,
      MailType: req.mailType ?? "TRANSACTIONAL",
      WebsiteURL: req.websiteUrl,
      UseCaseDescription: req.useCaseDescription,
      AdditionalContactEmailAddresses: req.additionalContactEmailAddresses,
      ContactLanguage: req.contactLanguage ?? "EN",
    }),
  );
  return { submitted: true };
}

/** One-line, doctor-friendly summary. */
export function describeSandboxStatus(s: SesAccountStatus): string {
  if (s.productionAccess) return `SES production access ENABLED (sending ${s.sendingEnabled ? "on" : "OFF"})`;
  return `SES SANDBOX (send only to verified identities; ${s.max24HourSend ?? "?"}/day, ${s.maxSendRate ?? "?"}/sec; sent ${s.sentLast24Hours ?? 0} in 24h)`;
}
