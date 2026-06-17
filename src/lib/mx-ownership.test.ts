import { describe, expect, it } from "bun:test";
import {
  classifyMxRecords,
  formatMxSwitchWarning,
  ownerForMxExchange,
  requiresMxSwitchConfirmation,
} from "./mx-ownership.js";

describe("MX ownership", () => {
  it("detects Google Workspace MX sets", () => {
    const assessment = classifyMxRecords([
      { exchange: "aspmx.l.google.com.", priority: 1 },
      { exchange: "alt1.aspmx.l.google.com.", priority: 5 },
    ], "example.com");

    expect(assessment.owner).toBe("google-workspace");
    expect(assessment.protects_existing_inbound).toBe(true);
    expect(requiresMxSwitchConfirmation(assessment)).toBe(true);
    expect(formatMxSwitchWarning(assessment)).toContain("Google Workspace");
  });

  it("does not require confirmation when SES already owns inbound", () => {
    const assessment = classifyMxRecords([
      { exchange: "inbound-smtp.us-east-1.amazonaws.com", priority: 10 },
    ], "example.com");

    expect(assessment.owner).toBe("aws-ses");
    expect(requiresMxSwitchConfirmation(assessment)).toBe(false);
  });

  it("detects mixed MX ownership", () => {
    const assessment = classifyMxRecords([
      { exchange: "aspmx.l.google.com", priority: 1 },
      { exchange: "inbound-smtp.us-east-1.amazonaws.com", priority: 10 },
    ], "example.com");

    expect(assessment.owner).toBe("mixed");
    expect(requiresMxSwitchConfirmation(assessment)).toBe(true);
  });

  it("requires explicit confirmation when MX ownership is unknown due to DNS uncertainty", () => {
    expect(requiresMxSwitchConfirmation({
      domain: "example.com",
      owner: "unknown",
      records: [],
      summary: "Could not resolve root MX records.",
      protects_existing_inbound: true,
    })).toBe(true);
  });

  it("recognizes common non-Google providers", () => {
    expect(ownerForMxExchange("route1.mx.cloudflare.net")).toBe("cloudflare-routing");
    expect(ownerForMxExchange("example-com.mail.protection.outlook.com")).toBe("microsoft-365");
    expect(ownerForMxExchange("mx.zoho.com")).toBe("zoho");
    expect(ownerForMxExchange("mail.protonmail.ch")).toBe("proton");
  });
});
