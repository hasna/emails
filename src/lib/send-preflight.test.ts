// `emails send --dry-run` must not answer identically for a sender that works and
// one that cannot possibly work.
//
// THE DEFECT (2026-07-27). The dry run was a pure client-side echo of its own
// arguments. Run three ways against a live deployment — a verified sender, an
// UNVERIFIED sender whose real send is refused with policy_denial
// `sender_unverified`, and an address that does not exist at all — it produced
// BYTE-IDENTICAL output. It was being used as a gate before a batch of real sends;
// it would have passed all of them and proved nothing.
//
// These tests pin the two things that make it a precheck: the codes match what the
// server would actually return, and a check that could not be performed is never
// reported as a pass.

import { describe, expect, it } from "bun:test";
import {
  describeUncheckedSendPolicy,
  evaluateAttachmentCaps,
  evaluateSenderPreflight,
} from "./send-preflight.js";
import {
  LOCAL_SEND_ATTACHMENT_LIMITS,
  SELF_HOSTED_SEND_ATTACHMENT_LIMITS,
} from "./send-attachment-limits.js";

const VERIFIED = { email: "ok@example.com", status: "active", verified: true };

describe("sender preflight distinguishes the cases the echo could not", () => {
  it("flags an address that does not exist at all", () => {
    const verdict = evaluateSenderPreflight("nobody@nowhere.invalid", null);
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe("sender_not_registered");
    expect(verdict.message).toContain("nobody@nowhere.invalid");
  });

  it("flags an unverified sender — the case that blocked real mail", () => {
    const verdict = evaluateSenderPreflight("pending@example.com", {
      email: "pending@example.com", status: "active", verified: false,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe("sender_unverified");
    // It must say the send never reaches a provider, and name the remedy — the two
    // facts that took five days to establish by hand.
    expect(verdict.message).toContain("before any provider is contacted");
    expect(verdict.message).toContain("emails address set-verified pending@example.com");
  });

  it("flags a suspended sender", () => {
    const verdict = evaluateSenderPreflight("susp@example.com", {
      email: "susp@example.com", status: "suspended", verified: true,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe("sender_inactive");
  });

  it("passes a registered, active, verified sender", () => {
    const verdict = evaluateSenderPreflight("ok@example.com", VERIFIED);
    expect(verdict.ok).toBe(true);
    expect(verdict.code).toBe("sender_checks_passed");
  });

  it("evaluates in the server's order, so the reported code is the one that would fire", () => {
    // Unverified AND suspended must report `sender_inactive`: evaluateOutboundPolicy
    // checks status before verified, so reporting sender_unverified would send the
    // operator to fix the wrong field.
    const verdict = evaluateSenderPreflight("both@example.com", {
      email: "both@example.com", status: "suspended", verified: false,
    });
    expect(verdict.code).toBe("sender_inactive");
  });

  it("never reports `ok` for the three failing cases — the byte-identical bug", () => {
    const outputs = [
      evaluateSenderPreflight("a@x.test", null),
      evaluateSenderPreflight("b@x.test", { email: "b@x.test", status: "active", verified: false }),
      evaluateSenderPreflight("c@x.test", VERIFIED),
    ];
    // The original defect was that these three produced the SAME text.
    expect(new Set(outputs.map((o) => o.message)).size).toBe(3);
    expect(outputs.map((o) => o.ok)).toEqual([false, false, true]);
  });
});

describe("attachment caps are evaluated, not merely printed", () => {
  const K = 1024;

  it("passes a set inside the self-hosted caps", () => {
    expect(evaluateAttachmentCaps(
      [{ filename: "a.pdf", bytes: 100 * K }, { filename: "b.pdf", bytes: 100 * K }],
      SELF_HOSTED_SEND_ATTACHMENT_LIMITS,
    )).toEqual([]);
  });

  it("catches a per-file overage that the old preview printed as fine", () => {
    // 600KiB is under the 25MB global ceiling readSendAttachments enforces, so
    // nothing else in the pipeline would have caught it before the server did.
    const findings = evaluateAttachmentCaps(
      [{ filename: "big.pdf", bytes: 600 * K }],
      SELF_HOSTED_SEND_ATTACHMENT_LIMITS,
    );
    expect(findings.map((f) => f.rule)).toContain("bytes_per_file");
    expect(findings[0]!.detail).toContain("big.pdf");
  });

  it("catches a total overage even when every file is individually legal", () => {
    const files = Array.from({ length: 3 }, (_, i) => ({ filename: `f${i}.pdf`, bytes: 400 * K }));
    const findings = evaluateAttachmentCaps(files, SELF_HOSTED_SEND_ATTACHMENT_LIMITS);
    expect(findings.map((f) => f.rule)).toContain("total_bytes");
    expect(findings.map((f) => f.rule)).not.toContain("bytes_per_file");
  });

  it("catches too many files", () => {
    const files = Array.from({ length: 6 }, (_, i) => ({ filename: `f${i}.txt`, bytes: 1 }));
    expect(evaluateAttachmentCaps(files, SELF_HOSTED_SEND_ATTACHMENT_LIMITS).map((f) => f.rule))
      .toContain("file_count");
  });

  it("applies the LOCAL caps in local mode, not the server's", () => {
    // A 600KiB file is refused self-hosted and fine locally. Predicting the wrong
    // mode's limits is the same class of defect as not predicting at all.
    const files = [{ filename: "big.pdf", bytes: 600 * K }];
    expect(evaluateAttachmentCaps(files, LOCAL_SEND_ATTACHMENT_LIMITS)).toEqual([]);
    expect(evaluateAttachmentCaps(files, SELF_HOSTED_SEND_ATTACHMENT_LIMITS).length).toBeGreaterThan(0);
  });

  it("reports every distinct violation rather than stopping at the first", () => {
    const files = Array.from({ length: 6 }, (_, i) => ({ filename: `f${i}.pdf`, bytes: 600 * K }));
    const rules = new Set(evaluateAttachmentCaps(files, SELF_HOSTED_SEND_ATTACHMENT_LIMITS).map((f) => f.rule));
    expect(rules).toEqual(new Set(["file_count", "bytes_per_file", "total_bytes"]));
  });
});

describe("the preview states what it did NOT check", () => {
  it("names the server-side state it cannot read, in self-hosted mode", () => {
    const note = describeUncheckedSendPolicy(true);
    for (const unchecked of ["send-key", "quota", "warming", "domain readiness", "provider acceptance"]) {
      expect(note.toLowerCase()).toContain(unchecked.toLowerCase());
    }
    // And it must refuse to be read as a guarantee.
    expect(note).toContain("does not guarantee delivery");
  });

  it("says local mode has no outbound policy gate at all", () => {
    expect(describeUncheckedSendPolicy(false)).toContain("no outbound policy gate");
  });
});
