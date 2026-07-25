// Provider send-error classification: a synchronous 4xx-class SDK reject means
// the provider REFUSED the request — nothing was handed off — so the outcome is
// definitively "not sent". Anything else (network failure, 5xx, unknown shape)
// is indeterminate: the request may have reached the provider, so it must stay
// "uncertain" and require reconciliation.

import { describe, expect, it } from "bun:test";
import { buildSelfHostedSender, classifyProviderSendError } from "./sender.js";

function awsError(name: string, message: string, httpStatusCode: number | undefined, fault?: "client" | "server"): Error {
  const err = new Error(message);
  err.name = name;
  Object.assign(err, {
    ...(httpStatusCode !== undefined ? { $metadata: { httpStatusCode } } : {}),
    ...(fault ? { $fault: fault } : {}),
  });
  return err;
}

describe("classifyProviderSendError", () => {
  it("classifies the SES sandbox MessageRejected (the 2026-07-25 incident error) as a definitive reject", () => {
    const outcome = classifyProviderSendError(awsError(
      "MessageRejected",
      "Email address is not verified. The following identities failed the check in region US-EAST-1: someone@external.example",
      400,
      "client",
    ));
    expect(outcome.kind).toBe("rejected");
    expect(outcome.providerErrorName).toBe("MessageRejected");
    expect(outcome.detail).toContain("Email address is not verified");
  });

  it("classifies other 4xx client faults (AccountSuspended, BadRequest, Throttling) as definitive rejects", () => {
    expect(classifyProviderSendError(awsError("AccountSuspendedException", "account suspended", 400, "client")).kind).toBe("rejected");
    expect(classifyProviderSendError(awsError("BadRequestException", "bad request", 400, "client")).kind).toBe("rejected");
    // Throttled = the provider refused to accept the request; nothing was sent.
    expect(classifyProviderSendError(awsError("TooManyRequestsException", "rate exceeded", 429, "client")).kind).toBe("rejected");
  });

  it("classifies Resend-style client errors ({ statusCode: 4xx }) as definitive rejects", () => {
    const err = Object.assign(new Error("validation_error: to is invalid"), { statusCode: 422, name: "validation_error" });
    expect(classifyProviderSendError(err).kind).toBe("rejected");
  });

  it("keeps provider 5xx responses uncertain (the provider may have processed the request)", () => {
    const outcome = classifyProviderSendError(awsError("InternalFailure", "internal error", 500, "server"));
    expect(outcome.kind).toBe("uncertain");
  });

  it("keeps network-level failures (no HTTP status) uncertain", () => {
    expect(classifyProviderSendError(new TypeError("fetch failed")).kind).toBe("uncertain");
    expect(classifyProviderSendError(awsError("TimeoutError", "socket hang up", undefined)).kind).toBe("uncertain");
  });

  it("keeps non-Error garbage uncertain and never throws", () => {
    expect(classifyProviderSendError(null).kind).toBe("uncertain");
    expect(classifyProviderSendError("boom").kind).toBe("uncertain");
    expect(classifyProviderSendError({ statusCode: "400" }).kind).toBe("uncertain");
  });

  it("caps the surfaced detail so a pathological provider message cannot flood the response", () => {
    const outcome = classifyProviderSendError(awsError("MessageRejected", "x".repeat(10_000), 400, "client"));
    expect(outcome.detail.length).toBeLessThanOrEqual(600);
  });
});

// ── which identity the self-hosted sender signs with ────────────────────────
//
// 2026-07-25 root cause: `providerRecord()` hardcoded `access_key: null,
// secret_key: null`, so the SES client ALWAYS fell through to the AWS default
// chain — the ECS task role of the deployment account, whose SES is in the
// sandbox. No amount of `emails provider add --access-key …` could change it.
describe("buildSelfHostedSender — SES credential resolution", () => {
  const base = { EMAILS_SEND_PROVIDER: "ses", EMAILS_AWS_REGION: "us-east-1" } as NodeJS.ProcessEnv;

  it("signs with the scoped SES key pair from the server environment when it is set", () => {
    const sender = buildSelfHostedSender({
      ...base,
      EMAILS_SES_ACCESS_KEY_ID: "AKIA-SERVER",
      EMAILS_SES_SECRET_ACCESS_KEY: "server-secret",
    });
    expect(sender.provider).toBe("ses");
    expect(sender.credentialSource).toBe("environment");
  });

  it("falls back to the deployment IAM role when nothing explicit is available", () => {
    const previousAccessKey = process.env["AWS_ACCESS_KEY_ID"];
    const previousSecretKey = process.env["AWS_SECRET_ACCESS_KEY"];
    try {
      delete process.env["AWS_ACCESS_KEY_ID"];
      delete process.env["AWS_SECRET_ACCESS_KEY"];
      expect(buildSelfHostedSender({ ...base }).credentialSource).toBe("deployment_role");
    } finally {
      if (previousAccessKey !== undefined) process.env["AWS_ACCESS_KEY_ID"] = previousAccessKey;
      if (previousSecretKey !== undefined) process.env["AWS_SECRET_ACCESS_KEY"] = previousSecretKey;
    }
  });

  it("does NOT read the generic AWS_* pair as a scoped SES configuration", () => {
    // The API container's task role also grants S3/SQS. Reading the generic
    // AWS_ACCESS_KEY_ID as the SES configuration would silently re-point every
    // AWS client in the process, so only the EMAILS_SES_* names may set the
    // provider record. A generic pair supplied here reaches nothing.
    const sender = buildSelfHostedSender({
      ...base,
      AWS_ACCESS_KEY_ID: "AKIA-AMBIENT",
      AWS_SECRET_ACCESS_KEY: "ambient-secret",
    });
    expect(sender.credentialSource).not.toBe("environment");
  });

  it("reports the identity the ADAPTER actually signs with, not the configured intent", () => {
    // The label is read off the constructed SES client. If it were derived from
    // "did we set EMAILS_SES_*?" it could claim `deployment_role` while the
    // AWS SDK quietly picked up a static pair from the process environment —
    // exactly the kind of gap between reported and real that caused the
    // incident.
    const previousAccessKey = process.env["AWS_ACCESS_KEY_ID"];
    const previousSecretKey = process.env["AWS_SECRET_ACCESS_KEY"];
    try {
      process.env["AWS_ACCESS_KEY_ID"] = "AKIA-PROCESS";
      process.env["AWS_SECRET_ACCESS_KEY"] = "process-secret";
      expect(buildSelfHostedSender({ ...base }).credentialSource).toBe("ambient_aws_env");
      // …and a scoped pair still wins over it.
      expect(buildSelfHostedSender({
        ...base,
        EMAILS_SES_ACCESS_KEY_ID: "AKIA-SERVER",
        EMAILS_SES_SECRET_ACCESS_KEY: "server-secret",
      }).credentialSource).toBe("environment");
    } finally {
      if (previousAccessKey === undefined) delete process.env["AWS_ACCESS_KEY_ID"];
      else process.env["AWS_ACCESS_KEY_ID"] = previousAccessKey;
      if (previousSecretKey === undefined) delete process.env["AWS_SECRET_ACCESS_KEY"];
      else process.env["AWS_SECRET_ACCESS_KEY"] = previousSecretKey;
    }
  });

  it("refuses half a scoped pair instead of silently completing it from the ambient chain", () => {
    expect(() => buildSelfHostedSender({ ...base, EMAILS_SES_ACCESS_KEY_ID: "AKIA-SERVER" }))
      .toThrow(/must be set together/);
    expect(() => buildSelfHostedSender({ ...base, EMAILS_SES_SECRET_ACCESS_KEY: "server-secret" }))
      .toThrow(/must be set together/);
  });

  it("never exposes a credential VALUE on the sender", () => {
    const sender = buildSelfHostedSender({
      ...base,
      EMAILS_SES_ACCESS_KEY_ID: "AKIA-SERVER",
      EMAILS_SES_SECRET_ACCESS_KEY: "server-secret",
    });
    const surfaced = JSON.stringify({ provider: sender.provider, credentialSource: sender.credentialSource });
    expect(surfaced).not.toContain("AKIA-SERVER");
    expect(surfaced).not.toContain("server-secret");
  });
});
