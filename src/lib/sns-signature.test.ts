import { describe, expect, it } from "bun:test";
import { createSign, generateKeyPairSync } from "node:crypto";
import {
  canonicalSnsMessage,
  isAwsSnsCertificateUrl,
  snsMessageAllowed,
  snsPolicyFromEnv,
  verifyAwsSnsSignature,
} from "./sns-signature.js";

const TOPIC = "arn:aws:sns:us-east-1:123456789012:emails-inbound";

function signedNotification(overrides: Record<string, unknown> = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const message: Record<string, unknown> = {
    Type: "Notification",
    MessageId: crypto.randomUUID(),
    TopicArn: TOPIC,
    Timestamp: "2026-07-10T12:00:00.000Z",
    Message: JSON.stringify({ notificationType: "Received" }),
    SignatureVersion: "2",
    SigningCertURL: `https://sns.us-east-1.amazonaws.com/SimpleNotificationService-${crypto.randomUUID()}.pem`,
    ...overrides,
  };
  const canonical = canonicalSnsMessage(message);
  if (!canonical) throw new Error("test SNS message is not canonicalizable");
  const signer = createSign("RSA-SHA256");
  signer.update(canonical, "utf8");
  signer.end();
  message["Signature"] = signer.sign(privateKey, "base64");
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { message, publicPem };
}

describe("AWS SNS signature verification", () => {
  it("accepts a valid signature from a host-pinned certificate URL", async () => {
    const { message, publicPem } = signedNotification();
    expect(await verifyAwsSnsSignature(message, async () => publicPem)).toBe(true);
  });

  it("rejects a tampered message", async () => {
    const { message, publicPem } = signedNotification();
    message["Message"] = "tampered";
    expect(await verifyAwsSnsSignature(message, async () => publicPem)).toBe(false);
  });

  it("rejects non-AWS and path-confused certificate URLs", () => {
    expect(isAwsSnsCertificateUrl("https://sns.us-east-1.amazonaws.com/SimpleNotificationService-good.pem")).toBe(true);
    expect(isAwsSnsCertificateUrl("https://sns.us-east-1.amazonaws.com:443/SimpleNotificationService-good.pem")).toBe(true);
    expect(isAwsSnsCertificateUrl("https://evil.example/SimpleNotificationService-good.pem")).toBe(false);
    expect(isAwsSnsCertificateUrl("https://sns.us-east-1.amazonaws.com/certs/SimpleNotificationService-good.pem")).toBe(false);
    expect(isAwsSnsCertificateUrl("http://sns.us-east-1.amazonaws.com/SimpleNotificationService-good.pem")).toBe(false);
    expect(isAwsSnsCertificateUrl("https://sns.us-east-1.amazonaws.com:444/SimpleNotificationService-good.pem")).toBe(false);
    expect(isAwsSnsCertificateUrl("https://user@sns.us-east-1.amazonaws.com/SimpleNotificationService-good.pem")).toBe(false);
    expect(isAwsSnsCertificateUrl("https://sns.us-east-1.amazonaws.com/SimpleNotificationService-good.pem?cache=no")).toBe(false);
    expect(isAwsSnsCertificateUrl("https://sns.us-east-1.amazonaws.com/SimpleNotificationService-good.pem#fragment")).toBe(false);
  });

  it("aborts and rejects a hung certificate fetch at the configured deadline", async () => {
    const { message } = signedNotification();
    let aborted = false;
    const startedAt = performance.now();
    await expect(
      verifyAwsSnsSignature(
        message,
        async (_url, signal) => new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          }, { once: true });
        }),
        { certificateTimeoutMs: 20 },
      ),
    ).rejects.toThrow("timed out");
    expect(aborted).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it("bounds the certificate cache and evicts the least recently used entry", async () => {
    const signed = [signedNotification(), signedNotification(), signedNotification()];
    let fetches = 0;
    const fetcher = async (url: string) => {
      fetches++;
      const match = signed.find(({ message }) => message["SigningCertURL"] === url);
      if (!match) throw new Error("unexpected certificate URL");
      return match.publicPem;
    };
    const options = { certificateCacheMaxEntries: 2 };

    for (const value of signed) {
      expect(await verifyAwsSnsSignature(value.message, fetcher, options)).toBe(true);
    }
    expect(await verifyAwsSnsSignature(signed[0]!.message, fetcher, options)).toBe(true);
    expect(fetches).toBe(4);
  });

  it("expires cached certificates after the configured TTL", async () => {
    const { message, publicPem } = signedNotification();
    let now = 100;
    let fetches = 0;
    const fetcher = async () => {
      fetches++;
      return publicPem;
    };
    const options = { certificateCacheTtlMs: 10, now: () => now };

    expect(await verifyAwsSnsSignature(message, fetcher, options)).toBe(true);
    now = 105;
    expect(await verifyAwsSnsSignature(message, fetcher, options)).toBe(true);
    now = 111;
    expect(await verifyAwsSnsSignature(message, fetcher, options)).toBe(true);
    expect(fetches).toBe(2);
  });

  it("does not cache a certificate that fails signature verification", async () => {
    const signed = signedNotification();
    const wrong = signedNotification();
    let fetches = 0;
    const fetcher = async () => {
      fetches++;
      return fetches === 1 ? wrong.publicPem : signed.publicPem;
    };

    expect(await verifyAwsSnsSignature(signed.message, fetcher)).toBe(false);
    expect(await verifyAwsSnsSignature(signed.message, fetcher)).toBe(true);
    expect(fetches).toBe(2);
  });

  it("requires an exact topic ARN and account allowlist", () => {
    const policy = snsPolicyFromEnv({
      EMAILS_SNS_TOPIC_ARNS: TOPIC,
      EMAILS_AWS_ACCOUNT_IDS: "123456789012",
    });
    expect(snsMessageAllowed({ TopicArn: TOPIC }, policy)).toBe(true);
    expect(snsMessageAllowed({ TopicArn: "arn:aws:sns:us-east-1:123456789012:other" }, policy)).toBe(false);
    expect(() => snsPolicyFromEnv({})).toThrow(/TOPIC_ARNS/);
  });
});
