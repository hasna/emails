import { createVerify } from "node:crypto";

const DEFAULT_CERTIFICATE_TIMEOUT_MS = 3_000;
const DEFAULT_CERTIFICATE_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_CERTIFICATE_CACHE_MAX_ENTRIES = 32;

interface CachedCertificate {
  certificate: string;
  expiresAt: number;
}

const certCache = new Map<string, CachedCertificate>();

function canonicalSnsCertificateUrl(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.port !== "" && url.port !== "443") ||
    url.search !== "" ||
    url.hash !== "" ||
    !/^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname) ||
    !/^\/SimpleNotificationService-[A-Za-z0-9_-]+\.pem$/.test(url.pathname)
  ) {
    return null;
  }
  return url.toString();
}

export function isAwsSnsCertificateUrl(value: string): boolean {
  return canonicalSnsCertificateUrl(value) !== null;
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

export type SnsCertificateFetcher = (url: string, signal: AbortSignal) => Promise<string>;

export interface SnsSignatureOptions {
  certificateTimeoutMs?: number;
  certificateCacheTtlMs?: number;
  certificateCacheMaxEntries?: number;
  now?: () => number;
}

function getCachedCertificate(url: string, now: number): string | null {
  const cached = certCache.get(url);
  if (!cached) return null;
  if (cached.expiresAt <= now) {
    certCache.delete(url);
    return null;
  }
  // Map insertion order is the LRU order. Refresh this entry on every hit.
  certCache.delete(url);
  certCache.set(url, cached);
  return cached.certificate;
}

function cacheCertificate(
  url: string,
  certificate: string,
  expiresAt: number,
  maxEntries: number,
): void {
  certCache.delete(url);
  while (certCache.size >= maxEntries) {
    const oldest = certCache.keys().next().value;
    if (typeof oldest !== "string") break;
    certCache.delete(oldest);
  }
  certCache.set(url, { certificate, expiresAt });
}

async function fetchCertificateWithTimeout(
  url: string,
  fetchCertificate: SnsCertificateFetcher,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("SNS signing certificate fetch timed out"));
    }, timeoutMs);
  });
  try {
    const certificate = await Promise.race([
      fetchCertificate(url, controller.signal),
      deadline,
    ]);
    if (certificate.length > 64 * 1024) {
      throw new Error("SNS signing certificate is too large");
    }
    return certificate;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function verifyAwsSnsSignature(
  message: Record<string, unknown>,
  fetchCertificate: SnsCertificateFetcher = async (url, signal) => {
    const response = await fetch(url, { redirect: "error", signal });
    if (!response.ok) throw new Error("SNS signing certificate fetch failed");
    const text = await response.text();
    return text;
  },
  options: SnsSignatureOptions = {},
): Promise<boolean> {
  const canonical = canonicalSnsMessage(message);
  const certUrl = canonicalSnsCertificateUrl(
    typeof message["SigningCertURL"] === "string" ? message["SigningCertURL"] : "",
  );
  const signature = typeof message["Signature"] === "string" ? message["Signature"] : "";
  const version = message["SignatureVersion"];
  if (!canonical || !signature || !certUrl || (version !== "1" && version !== "2")) return false;

  const timeoutMs = options.certificateTimeoutMs ?? DEFAULT_CERTIFICATE_TIMEOUT_MS;
  const ttlMs = options.certificateCacheTtlMs ?? DEFAULT_CERTIFICATE_CACHE_TTL_MS;
  const maxEntries = options.certificateCacheMaxEntries ?? DEFAULT_CERTIFICATE_CACHE_MAX_ENTRIES;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("SNS certificate timeout must be positive");
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("SNS certificate cache TTL must be positive");
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new Error("SNS certificate cache size must be a positive integer");

  const now = options.now?.() ?? Date.now();
  let certificate = getCachedCertificate(certUrl, now);
  let fetched = false;
  if (!certificate) {
    certificate = await fetchCertificateWithTimeout(certUrl, fetchCertificate, timeoutMs);
    fetched = true;
  }
  const verifier = createVerify(version === "1" ? "RSA-SHA1" : "RSA-SHA256");
  verifier.update(canonical, "utf8");
  verifier.end();
  try {
    const valid = verifier.verify(certificate, signature, "base64");
    // Do not let an invalid or transient certificate response poison the cache.
    if (valid && fetched) cacheCertificate(certUrl, certificate, now + ttlMs, maxEntries);
    return valid;
  } catch {
    return false;
  }
}
