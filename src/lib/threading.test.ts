import { describe, it, expect } from "bun:test";
import { generateMessageId, buildThreadingHeaders, parseReferences } from "./threading.js";

describe("generateMessageId", () => {
  it("produces an RFC Message-ID <id@domain>", () => {
    const m = generateMessageId("example.com", "abc-123");
    expect(m).toBe("<abc-123@example.com>");
  });
  it("auto-generates the local part when not given", () => {
    const m = generateMessageId("example.com");
    expect(m).toMatch(/^<[a-z0-9-]+@example\.com>$/);
  });
});

describe("buildThreadingHeaders — full References chain", () => {
  it("first reply: In-Reply-To = parent id, References = [parent id]", () => {
    const h = buildThreadingHeaders({ message_id: "<root@x.com>", references: [] });
    expect(h.inReplyTo).toBe("<root@x.com>");
    expect(h.references).toEqual(["<root@x.com>"]);
  });
  it("third message: References accumulates the whole ancestry", () => {
    // parent is the 2nd message, whose references already include the root
    const h = buildThreadingHeaders({ message_id: "<msg2@x.com>", references: ["<root@x.com>"] });
    expect(h.inReplyTo).toBe("<msg2@x.com>");
    expect(h.references).toEqual(["<root@x.com>", "<msg2@x.com>"]);
  });
  it("does not duplicate the parent id if already in references", () => {
    const h = buildThreadingHeaders({ message_id: "<msg2@x.com>", references: ["<root@x.com>", "<msg2@x.com>"] });
    expect(h.references).toEqual(["<root@x.com>", "<msg2@x.com>"]);
  });
  it("emits a References header string joined by spaces", () => {
    const h = buildThreadingHeaders({ message_id: "<b@x.com>", references: ["<a@x.com>"] });
    expect(h.referencesHeader).toBe("<a@x.com> <b@x.com>");
    expect(h.inReplyToHeader).toBe("<b@x.com>");
  });
});

describe("parseReferences", () => {
  it("splits a References header into ids", () => {
    expect(parseReferences("<a@x.com> <b@x.com>")).toEqual(["<a@x.com>", "<b@x.com>"]);
    expect(parseReferences("")).toEqual([]);
    expect(parseReferences(undefined)).toEqual([]);
  });
});
