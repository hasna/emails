import { describe, expect, it } from "bun:test";
import { brandSightEmailRecords } from "./brandsight-dns.js";
import type { DnsRecord } from "../types/index.js";

describe("BrandSight DNS helpers", () => {
  it("converts provider records to BrandSight-relative names and absolute host targets", () => {
    const providerRecords: DnsRecord[] = [
      {
        type: "TXT",
        name: "_amazonses.example.com",
        value: "ses-token",
        purpose: "SES_IDENTITY",
      },
      {
        type: "CNAME",
        name: "abc._domainkey.example.com",
        value: "abc.dkim.amazonses.com",
        purpose: "DKIM",
      },
      {
        type: "TXT",
        name: "example.com",
        value: "v=spf1 include:amazonses.com ~all",
        purpose: "SPF",
      },
    ];

    const records = brandSightEmailRecords({
      domain: "example.com",
      providerRecords,
      region: "us-east-1",
      addMx: true,
      mailFromDomain: "mail.example.com",
    });

    expect(records).toContainEqual({
      type: "TXT",
      name: "_amazonses",
      data: "ses-token",
      ttl: 600,
    });
    expect(records).toContainEqual({
      type: "CNAME",
      name: "abc._domainkey",
      data: "abc.dkim.amazonses.com.",
      ttl: 600,
    });
    expect(records).toContainEqual({
      type: "MX",
      name: "@",
      data: "inbound-smtp.us-east-1.amazonaws.com.",
      priority: 10,
      ttl: 600,
    });
    expect(records).toContainEqual({
      type: "MX",
      name: "mail",
      data: "feedback-smtp.us-east-1.amazonses.com.",
      priority: 10,
      ttl: 600,
    });
  });
});
