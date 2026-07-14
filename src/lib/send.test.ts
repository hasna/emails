import { describe, it, expect } from "bun:test";
import {
  assertWarmingLimit,
  assertDomainOutboundReady,
  sendWithFailover,
  validateSendAttachments,
  getAttachmentDecodedSize,
  MAX_ATTACHMENT_COUNT,
  MAX_ATTACHMENT_SIZE_BYTES,
} from "./send.remote.js";
import type { Provider, SendEmailOptions } from "../types/index.js";

// In the self-hosted client, outbound sending goes through the authenticated /v1
// send endpoint via resolveMailDataSource().send(...). The local provider-adapter
// send path (failover, local send-key auth, address-sendability +
// domain-outbound-readiness + warming guards) does not exist client-side, so
// those entrypoints are loud stubs. The pure attachment validators still run.

function fakeProvider(overrides: Partial<Provider> = {}): Provider {
  return { id: "prov-1", name: "sandbox", type: "sandbox", ...overrides } as unknown as Provider;
}

const baseOpts: SendEmailOptions = { from: "sender@example.com", to: "to@x.com", subject: "hi", text: "yo" };

describe("validateSendAttachments (pure)", () => {
  it("allows a normal set of attachments", () => {
    expect(() =>
      validateSendAttachments([
        { filename: "a.txt", content: Buffer.from("hello").toString("base64"), content_type: "text/plain" },
      ]),
    ).not.toThrow();
  });

  it("allows no attachments", () => {
    expect(() => validateSendAttachments(undefined)).not.toThrow();
    expect(() => validateSendAttachments([])).not.toThrow();
  });

  it("blocks too many attachments", () => {
    expect(() =>
      validateSendAttachments(
        Array.from({ length: MAX_ATTACHMENT_COUNT + 1 }, (_, index) => ({
          filename: `file-${index}.txt`,
          content: Buffer.from("small").toString("base64"),
          content_type: "text/plain",
        })),
      ),
    ).toThrow(/too many attachments/i);
  });

  it("blocks a single attachment larger than 25MB", () => {
    expect(() =>
      validateSendAttachments([
        {
          filename: "large.bin",
          content: Buffer.alloc(MAX_ATTACHMENT_SIZE_BYTES + 1).toString("base64"),
          content_type: "application/octet-stream",
        },
      ]),
    ).toThrow(/too large/i);
  });

  it("getAttachmentDecodedSize reports the decoded byte length", () => {
    const content = Buffer.from("hello-world").toString("base64");
    expect(getAttachmentDecodedSize(content)).toBe("hello-world".length);
  });
});

describe("assertWarmingLimit (self-hosted stub)", () => {
  it("throws because warming rate limits are enforced on the self-hosted server", () => {
    expect(() => assertWarmingLimit(baseOpts)).toThrow(
      /assertWarmingLimit is not available in the self-hosted client/,
    );
  });
});

describe("assertDomainOutboundReady (self-hosted stub)", () => {
  it("throws because outbound readiness is enforced on the self-hosted server", () => {
    expect(() => assertDomainOutboundReady(fakeProvider({ name: "ses-real", id: "p9" }), baseOpts)).toThrow(
      /Self-hosted sends must use the authenticated Emails \/v1 send endpoint/i,
    );
  });

  it("mentions the provider name and id in the guidance", () => {
    expect(() => assertDomainOutboundReady(fakeProvider({ name: "ses-real", id: "p9" }), baseOpts)).toThrow(
      /ses-real.*p9/i,
    );
  });
});

describe("sendWithFailover (self-hosted stub)", () => {
  it("throws directing callers to the /v1 send endpoint", async () => {
    await expect(sendWithFailover("prov-1", baseOpts)).rejects.toThrow(
      /sendWithFailover is not available in the self-hosted client/,
    );
  });
});
