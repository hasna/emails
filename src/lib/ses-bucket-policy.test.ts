import { describe, it, expect } from "bun:test";
import { buildSesBucketPolicy } from "./aws-inbound.js";

describe("buildSesBucketPolicy", () => {
  it("uses aws:SourceAccount (lowercase) with the real account id", () => {
    const p = buildSesBucketPolicy("b", "inbound/x.com/", "123456789012") as any;
    const stmt = p.Statement[0];
    expect(stmt.Principal.Service).toBe("ses.amazonaws.com");
    expect(stmt.Action).toBe("s3:PutObject");
    // Shared inbound base, NOT per-domain — a per-domain grant gets clobbered on
    // the next `domain adopt` (PutBucketPolicy replaces the whole policy).
    expect(stmt.Resource).toBe("arn:aws:s3:::b/inbound/*");
    expect(stmt.Condition.StringEquals["aws:SourceAccount"]).toBe("123456789012");
  });
  it("omits the condition when account id is unknown (never uses literal '*')", () => {
    const p = buildSesBucketPolicy("b", "inbound/x.com/") as any;
    expect(p.Statement[0].Condition).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain('"*"');
  });
});
