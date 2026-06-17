import { describe, expect, it } from "bun:test";
import { assessDomainReadiness } from "./domain-readiness.js";

describe("assessDomainReadiness", () => {
  it("marks verified sending plus inbound as ready to send and receive", () => {
    const readiness = assessDomainReadiness(
      { domain: "example.com", dkim_status: "verified", spf_status: "verified", dmarc_status: "pending" },
      { provisioning_status: "ready", purchase_provider: null, dns_provider: "cloudflare", send_provider: "ses", cf_zone_id: null, registrar: null, nameservers: [], mail_from_domain: "mail.example.com", last_error: null, next_check_at: null },
    );

    expect(readiness.send_ready).toBe(true);
    expect(readiness.receive_ready).toBe(true);
    expect(readiness.state).toBe("ready_to_send_and_receive");
  });

  it("marks failed DNS as broken with fix commands", () => {
    const readiness = assessDomainReadiness(
      { domain: "example.com", dkim_status: "failed", spf_status: "verified", dmarc_status: "pending" },
      null,
    );

    expect(readiness.state).toBe("broken");
    expect(readiness.fix_commands.join(" ")).toContain("domain check example.com");
  });

  it("treats ready receive addresses as receive readiness evidence", () => {
    const readiness = assessDomainReadiness(
      { domain: "example.com", dkim_status: "verified", spf_status: "verified", dmarc_status: "pending" },
      null,
      { ready_addresses: 1 },
    );

    expect(readiness.receive_ready).toBe(true);
    expect(readiness.ready_addresses).toBe(1);
    expect(readiness.state).toBe("ready_to_send_and_receive");
  });

  it("uses safe dry-run guidance when receive readiness is missing", () => {
    const readiness = assessDomainReadiness(
      { domain: "example.com", dkim_status: "verified", spf_status: "verified", dmarc_status: "verified" },
      null,
    );

    expect(readiness.receive_ready).toBe(false);
    expect(readiness.fix_commands).toContain("mailery domain check example.com");
    expect(readiness.fix_commands).toContain("mailery provision domain example.com --provider <provider> --dry-run");
    expect(readiness.fix_commands.join(" ")).not.toContain("domain adopt");
  });
});
