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
    expect(isAwsSnsCertificateUrl("https://evil.example/SimpleNotificationService-good.pem")).toBe(false);
    expect(isAwsSnsCertificateUrl("https://sns.us-east-1.amazonaws.com/certs/SimpleNotificationService-good.pem")).toBe(false);
    expect(isAwsSnsCertificateUrl("http://sns.us-east-1.amazonaws.com/SimpleNotificationService-good.pem")).toBe(false);
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
