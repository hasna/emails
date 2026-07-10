import { createVerify } from "node:crypto";

const certCache = new Map<string, string>();

export function isAwsSnsCertificateUrl(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === "https:"
    && /^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname)
    && /^\/SimpleNotificationService-[A-Za-z0-9_-]+\.pem$/.test(url.pathname);
}

export function canonicalSnsMessage(message: Record<string, unknown>): string | null {
  const type = message["Type"];
  const fields = type === "Notification"
    ? ["Message", "MessageId", ...(message["Subject"] === undefined ? [] : ["Subject"]), "Timestamp", "TopicArn", "Type"]
    : type === "SubscriptionConfirmation" || type === "UnsubscribeConfirmation"
      ? ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"]
      : null;
  if (!fields) return null;
  let canonical = "";
  for (const field of fields) {
    if (typeof message[field] !== "string") return null;
    canonical += `${field}\n${message[field]}\n`;
  }
  return canonical;
}

export interface SnsPolicy {
  topicArns: Set<string>;
  accountIds: Set<string>;
}

export function snsPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): SnsPolicy {
  const topicArns = new Set((env["EMAILS_SNS_TOPIC_ARNS"] ?? env["EMAILS_SNS_TOPIC_ARN"] ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean));
  const accountIds = new Set((env["EMAILS_AWS_ACCOUNT_IDS"] ?? env["EMAILS_AWS_ACCOUNT_ID"] ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean));
  if (topicArns.size === 0) throw new Error("EMAILS_SNS_TOPIC_ARNS is required for the SES inbound webhook");
  if (accountIds.size === 0) throw new Error("EMAILS_AWS_ACCOUNT_IDS is required for the SES inbound webhook");
  return { topicArns, accountIds };
}

export function snsMessageAllowed(message: Record<string, unknown>, policy: SnsPolicy): boolean {
  const topicArn = typeof message["TopicArn"] === "string" ? message["TopicArn"] : "";
  const accountId = topicArn.split(":")[4] ?? "";
  return policy.topicArns.has(topicArn) && policy.accountIds.has(accountId);
}

export async function verifyAwsSnsSignature(
  message: Record<string, unknown>,
  fetchCertificate: (url: string) => Promise<string> = async (url) => {
    const response = await fetch(url, { redirect: "error" });
    if (!response.ok) throw new Error("SNS signing certificate fetch failed");
    const text = await response.text();
    if (text.length > 64 * 1024) throw new Error("SNS signing certificate is too large");
    return text;
  },
): Promise<boolean> {
  const canonical = canonicalSnsMessage(message);
  const certUrl = typeof message["SigningCertURL"] === "string" ? message["SigningCertURL"] : "";
  const signature = typeof message["Signature"] === "string" ? message["Signature"] : "";
  const version = message["SignatureVersion"];
  if (!canonical || !signature || !isAwsSnsCertificateUrl(certUrl) || (version !== "1" && version !== "2")) return false;
  let certificate = certCache.get(certUrl);
  if (!certificate) {
    certificate = await fetchCertificate(certUrl);
    certCache.set(certUrl, certificate);
  }
  const verifier = createVerify(version === "1" ? "RSA-SHA1" : "RSA-SHA256");
  verifier.update(canonical, "utf8");
  verifier.end();
  try { return verifier.verify(certificate, signature, "base64"); } catch { return false; }
}
