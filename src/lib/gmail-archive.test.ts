import { describe, expect, it } from "bun:test";
import { buildGmailArchiveKeys } from "./gmail-archive.js";

describe("buildGmailArchiveKeys", () => {
  it("builds deterministic prod-emails Gmail keys by profile and message", () => {
    expect(buildGmailArchiveKeys({
      prefix: "gmail",
      profile: "andrei@hasna.com",
      messageId: "190971d5a7402e62",
    })).toEqual({
      raw: "gmail/andrei_hasna.com/raw/190971d5a7402e62.eml",
      metadata: "gmail/andrei_hasna.com/metadata/190971d5a7402e62.json",
    });
  });

  it("normalizes unsafe path segments", () => {
    expect(buildGmailArchiveKeys({
      prefix: "/gmail/",
      profile: "../default profile",
      messageId: "msg/id",
    })).toEqual({
      raw: "gmail/.._default_profile/raw/msg_id.eml",
      metadata: "gmail/.._default_profile/metadata/msg_id.json",
    });
  });
});
