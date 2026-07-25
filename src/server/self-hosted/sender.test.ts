// Provider send-error classification: a synchronous 4xx-class SDK reject means
// the provider REFUSED the request — nothing was handed off — so the outcome is
// definitively "not sent". Anything else (network failure, 5xx, unknown shape)
// is indeterminate: the request may have reached the provider, so it must stay
// "uncertain" and require reconciliation.

import { describe, expect, it } from "bun:test";
import { classifyProviderSendError } from "./sender.js";

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
