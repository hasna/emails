/**
 * Receipt honesty for the SQLite-store SES webhook mount (bug d4e956ce).
 *
 * receivers.ts documents the ledger invariant: the receipt is recorded ONLY
 * after the persistence side effect succeeded. `syncS3Inbox` swallows every
 * per-object and listing failure into `result.errors` and returns
 * `{ synced: 0 }` without throwing — so this mount must treat a sync result
 * that carries errors as a FAILED ingest: no receipt, non-acknowledging
 * outcome, and every SNS redelivery re-attempts the ingest instead of being
 * answered "duplicate". Otherwise mail notified during an outage (e.g. the
 * 07-28 AccessDenied freeze) is permanently receipted with zero rows stored.
 */
import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { handleInboundWebhook } from "./inbound-webhook.js";
import { setConfigValue } from "../../lib/config.js";
import { closeDatabase, resetDatabase } from "../../db/database.js";

let INHERITED_PROCESS_ENV: NodeJS.ProcessEnv;
function captureInheritedProcessEnv(): void {
  INHERITED_PROCESS_ENV = { ...process.env };
}
function restoreInheritedProcessEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
}

const TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:emails-inbound";
let snsSequence = 0;

beforeEach(() => {
  captureInheritedProcessEnv();
  process.env["EMAILS_DB_PATH"] = ":memory:";
  process.env["EMAILS_SNS_TOPIC_ARNS"] = TOPIC_ARN;
  process.env["EMAILS_AWS_ACCOUNT_IDS"] = "123456789012";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  delete process.env["EMAILS_SNS_TOPIC_ARNS"];
  delete process.env["EMAILS_AWS_ACCOUNT_IDS"];
  restoreInheritedProcessEnv();
});

const sesNotification = JSON.stringify({
  notificationType: "Received",
  mail: { messageId: "msg-h", destination: ["ops@acme.com"] },
  receipt: { recipients: ["ops@acme.com"], action: { type: "S3", bucketName: "acme-inbound", objectKey: "inbound/acme.com/msg-h" } },
});

function post(body: unknown): Request {
  return new Request("http://x/webhook/ses-inbound", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function sns(body: Record<string, unknown>): Record<string, unknown> {
  return {
    MessageId: `sns-honesty-${++snsSequence}`,
    TopicArn: TOPIC_ARN,
    Signature: "test-signature",
    SignatureVersion: "2",
    SigningCertURL: "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem",
    Timestamp: new Date().toISOString(),
    ...body,
  };
}

const verified = { verifySns: async () => true };

describe("inbound webhook — swallowed sync errors are a FAILED ingest", () => {
  it("does not receipt a sync that lost every object, so redelivery re-attempts", async () => {
    setConfigValue("inbound_s3_bucket", "configured-inbound");
    setConfigValue("inbound_s3_prefix", "inbound/");
    try {
      const notification = sns({ Type: "Notification", Message: sesNotification });
      let attempts = 0;
      const deps = {
        ...verified,
        sync: async () => {
          attempts++;
          return { synced: 0, errors: ["inbound/acme.com/msg-h: AccessDenied"] };
        },
      };
      // The failure must NOT be 200-acknowledged (that would write the receipt).
      await expect(handleInboundWebhook(post(notification), "/webhook/ses-inbound", "POST", deps))
        .rejects.toThrow(/AccessDenied/);
      // Redelivery of the SAME MessageId must re-run the sync — not answer "duplicate".
      await expect(handleInboundWebhook(post(notification), "/webhook/ses-inbound", "POST", deps))
        .rejects.toThrow(/AccessDenied/);
      expect(attempts).toBe(2);
    } finally {
      setConfigValue("inbound_s3_bucket", undefined);
      setConfigValue("inbound_s3_prefix", undefined);
    }
  });

  it("does not receipt a partially failed ingest either", async () => {
    setConfigValue("inbound_s3_bucket", "configured-inbound");
    setConfigValue("inbound_s3_prefix", "inbound/");
    try {
      const notification = sns({ Type: "Notification", Message: sesNotification });
      let attempts = 0;
      const deps = {
        ...verified,
        sync: async () => {
          attempts++;
          // One object landed, one was lost. Re-ingest is dedup-safe, so the
          // receipt must wait until a run with zero errors.
          return { synced: 1, errors: ["inbound/acme.com/other: read timed out"] };
        },
      };
      await expect(handleInboundWebhook(post(notification), "/webhook/ses-inbound", "POST", deps))
        .rejects.toThrow(/read timed out/);
      await expect(handleInboundWebhook(post(notification), "/webhook/ses-inbound", "POST", deps))
        .rejects.toThrow(/read timed out/);
      expect(attempts).toBe(2);
    } finally {
      setConfigValue("inbound_s3_bucket", undefined);
      setConfigValue("inbound_s3_prefix", undefined);
    }
  });

  it("still acknowledges and receipts a clean sync (errors empty)", async () => {
    setConfigValue("inbound_s3_bucket", "configured-inbound");
    setConfigValue("inbound_s3_prefix", "inbound/");
    try {
      const notification = sns({ Type: "Notification", Message: sesNotification });
      let attempts = 0;
      const deps = {
        ...verified,
        sync: async () => { attempts++; return { synced: 1, errors: [] }; },
      };
      const first = await handleInboundWebhook(post(notification), "/webhook/ses-inbound", "POST", deps);
      expect(first!.status).toBe(200);
      const second = await handleInboundWebhook(post(notification), "/webhook/ses-inbound", "POST", deps);
      expect((await second!.json()).duplicate).toBe(true);
      expect(attempts).toBe(1);
    } finally {
      setConfigValue("inbound_s3_bucket", undefined);
      setConfigValue("inbound_s3_prefix", undefined);
    }
  });
});
