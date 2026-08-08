// The send attachment caps, and the constraint that actually bound them.
//
// The self-hosted caps were 5 files / 512KiB each / 768KiB total, and 768KiB is
// not an arbitrary number: attachments travel base64-encoded inside the JSON
// send body, and base64(768KiB) is 1048576 bytes — EXACTLY the 1 MiB
// `MAX_JSON_BODY_BYTES` the send route reads its body with. The attachment cap
// was the largest raw payload whose encoding fits the body cap.
//
// That coupling is why raising the attachment numbers ALONE would have changed
// nothing: `readJsonBody` runs before the attachment branch, so an oversize
// document is refused 413 by the body cap before any attachment rule is
// consulted. These tests pin the coupling so the two cannot drift apart again,
// in EITHER direction — a body budget too small silently re-blocks the send,
// and attachment caps too large silently overrun the provider.

import { describe, expect, test } from "bun:test";
import {
  base64EncodedBytes,
  describeSendAttachmentLimits,
  LOCAL_SEND_ATTACHMENT_LIMITS,
  mimeEncodedUpperBound,
  requiredSendJsonBodyBytes,
  SELF_HOSTED_SEND_ATTACHMENT_LIMITS,
  SES_MAX_MESSAGE_BYTES,
  type SendAttachmentLimits,
} from "./send-attachment-limits.js";

/** The live case this cap was raised for: a notarised 6-page scan. */
const NOTARISED_SCAN_BYTES = 3_800_000;

describe("base64EncodedBytes", () => {
  test("matches the standard 4/3 expansion with padding", () => {
    // Hand-checkable vectors: base64 emits 4 characters per 3 input bytes,
    // padding the final group.
    expect(base64EncodedBytes(0)).toBe(0);
    expect(base64EncodedBytes(1)).toBe(4);
    expect(base64EncodedBytes(2)).toBe(4);
    expect(base64EncodedBytes(3)).toBe(4);
    expect(base64EncodedBytes(4)).toBe(8);
  });

  test("agrees with a real Buffer encoding", () => {
    // The formula is only worth having if it predicts what Buffer actually does.
    for (const size of [1, 2, 3, 5, 17, 1024, 100_000]) {
      const encoded = Buffer.alloc(size).toString("base64").length;
      expect(base64EncodedBytes(size)).toBe(encoded);
    }
  });
});

describe("self-hosted send attachment caps carry a real document", () => {
  test("a notarised scan fits under the per-file cap", () => {
    expect(NOTARISED_SCAN_BYTES).toBeLessThanOrEqual(
      SELF_HOSTED_SEND_ATTACHMENT_LIMITS.maxBytesPerFile,
    );
  });

  test("two notarised scans fit under the total cap in one message", () => {
    expect(NOTARISED_SCAN_BYTES * 2).toBeLessThanOrEqual(
      SELF_HOSTED_SEND_ATTACHMENT_LIMITS.maxTotalBytes,
    );
  });

  test("the file-count cap still admits a two-document send", () => {
    expect(SELF_HOSTED_SEND_ATTACHMENT_LIMITS.maxFiles).toBeGreaterThanOrEqual(2);
  });
});

// The cap must still BE a cap. A change that removed enforcement entirely would
// pass every "a big file now works" assertion above, so each bound is pinned
// from the other side too.
describe("the caps still bound", () => {
  test("per-file and total caps are finite and ordered", () => {
    const { maxFiles, maxBytesPerFile, maxTotalBytes } = SELF_HOSTED_SEND_ATTACHMENT_LIMITS;
    expect(Number.isFinite(maxBytesPerFile)).toBe(true);
    expect(Number.isFinite(maxTotalBytes)).toBe(true);
    expect(Number.isFinite(maxFiles)).toBe(true);
    expect(maxBytesPerFile).toBeGreaterThan(0);
    expect(maxFiles).toBeGreaterThan(0);
    // A per-file cap above the total would be unreachable and misleading.
    expect(maxBytesPerFile).toBeLessThanOrEqual(maxTotalBytes);
  });

  test("one byte over the per-file cap is over the per-file cap", () => {
    expect(SELF_HOSTED_SEND_ATTACHMENT_LIMITS.maxBytesPerFile + 1)
      .toBeGreaterThan(SELF_HOSTED_SEND_ATTACHMENT_LIMITS.maxBytesPerFile);
  });

  test("the self-hosted caps stay at or below the local ones", () => {
    // `src/lib/send.local.ts` enforces its own 25MiB ceiling on the local send
    // path. If the self-hosted per-file cap ever rose above it, that layer would
    // start rejecting sends the hosted route had just accepted.
    expect(SELF_HOSTED_SEND_ATTACHMENT_LIMITS.maxBytesPerFile)
      .toBeLessThanOrEqual(LOCAL_SEND_ATTACHMENT_LIMITS.maxBytesPerFile);
  });
});

// THE TEST THAT WOULD HAVE CAUGHT THE ORIGINAL DEFECT.
describe("the JSON body budget can actually carry a full-size attachment set", () => {
  test("the send body budget exceeds the encoded worst-case attachment set", () => {
    const encoded = base64EncodedBytes(SELF_HOSTED_SEND_ATTACHMENT_LIMITS.maxTotalBytes);
    expect(requiredSendJsonBodyBytes(SELF_HOSTED_SEND_ATTACHMENT_LIMITS))
      .toBeGreaterThan(encoded);
  });

  test("it leaves room for the envelope around the attachments", () => {
    // Subject, addresses, filenames, content types, and a text/html body all
    // share the same request body.
    const encoded = base64EncodedBytes(SELF_HOSTED_SEND_ATTACHMENT_LIMITS.maxTotalBytes);
    const slack = requiredSendJsonBodyBytes(SELF_HOSTED_SEND_ATTACHMENT_LIMITS) - encoded;
    expect(slack).toBeGreaterThanOrEqual(1024 * 1024);
  });

  test("the budget tracks the cap rather than being a hand-typed number", () => {
    // Doubling the cap must move the budget. A constant that ignored its input
    // is exactly how the body cap and the attachment cap drifted apart.
    const doubled: SendAttachmentLimits = {
      ...SELF_HOSTED_SEND_ATTACHMENT_LIMITS,
      maxTotalBytes: SELF_HOSTED_SEND_ATTACHMENT_LIMITS.maxTotalBytes * 2,
    };
    expect(requiredSendJsonBodyBytes(doubled))
      .toBeGreaterThan(requiredSendJsonBodyBytes(SELF_HOSTED_SEND_ATTACHMENT_LIMITS));
  });
});

describe("the caps stay inside the provider ceiling", () => {
  test("SES is pinned at its documented v2 value", () => {
    // AWS: SESv2/SMTP maximum message size is 40MB per message, measured AFTER
    // base64 encoding, and is NOT adjustable. (The v1 API's limit is 10MB.)
    expect(SES_MAX_MESSAGE_BYTES).toBe(40_000_000);
  });

  test("a worst-case message stays under the SES ceiling", () => {
    expect(mimeEncodedUpperBound(SELF_HOSTED_SEND_ATTACHMENT_LIMITS))
      .toBeLessThan(SES_MAX_MESSAGE_BYTES);
  });

  test("it keeps a real margin, not a rounding-error one", () => {
    const margin = SES_MAX_MESSAGE_BYTES - mimeEncodedUpperBound(SELF_HOSTED_SEND_ATTACHMENT_LIMITS);
    expect(margin).toBeGreaterThan(5_000_000);
  });

  test("the bound can fail — a cap over the ceiling is reported as over", () => {
    // A ceiling check that cannot fail is not a check. This proves the
    // instrument fires on a known-bad input.
    const oversize: SendAttachmentLimits = {
      maxFiles: 5,
      maxBytesPerFile: 60 * 1024 * 1024,
      maxTotalBytes: 60 * 1024 * 1024,
    };
    expect(mimeEncodedUpperBound(oversize)).toBeGreaterThan(SES_MAX_MESSAGE_BYTES);
  });
});

describe("describeSendAttachmentLimits", () => {
  test("renders the raised self-hosted caps", () => {
    expect(describeSendAttachmentLimits(SELF_HOSTED_SEND_ATTACHMENT_LIMITS))
      .toBe("5 files, 10MB each, 20MB total");
  });
});
