import { describe, it, expect } from "bun:test";
import { checkProvisionCredentials } from "./provision-creds.js";

describe("checkProvisionCredentials", () => {
  it("detects AWS profile, Cloudflare global key+account, Resend", () => {
    const s = checkProvisionCredentials({
      AWS_PROFILE: "hasna",
      CLOUDFLARE_API_KEY: "k", CLOUDFLARE_EMAIL: "a@b.com", CLOUDFLARE_ACCOUNT_ID: "acct",
      RESEND_API_KEY: "re_x",
    });
    expect(s.find((x) => x.provider === "aws")!.configured).toBe(true);
    const cf = s.find((x) => x.provider === "cloudflare")!;
    expect(cf.configured).toBe(true);
    expect(cf.detail).toContain("global key");
    expect(cf.detail).toContain("account");
    expect(s.find((x) => x.provider === "resend")!.configured).toBe(true);
  });

  it("flags missing cloudflare account id", () => {
    const cf = checkProvisionCredentials({ CLOUDFLARE_API_TOKEN: "t" }).find((x) => x.provider === "cloudflare")!;
    expect(cf.detail).toMatch(/account id/i);
  });

  it("detects Cloudflare global key from stored config", () => {
    const cf = checkProvisionCredentials({}, {
      cloudflare_api_key: "k",
      cloudflare_email: "a@b.com",
      cloudflare_account_id: "acct",
    }).find((x) => x.provider === "cloudflare")!;
    expect(cf.configured).toBe(true);
    expect(cf.detail).toContain("global key");
    expect(cf.detail).toContain("account");
  });

  it("accepts stored SES provider credentials for AWS provisioning", () => {
    const aws = checkProvisionCredentials({}, {
      aws_provider_credentials: true,
    }).find((x) => x.provider === "aws")!;
    expect(aws.configured).toBe(true);
    expect(aws.detail).toContain("stored SES provider credentials");
  });

  it("resend optional when absent", () => {
    expect(checkProvisionCredentials({}).find((x) => x.provider === "resend")!.configured).toBe(false);
  });
});
