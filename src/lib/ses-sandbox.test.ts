import { describe, it, expect } from "bun:test";
import { getSandboxStatus, requestProductionAccess, describeSandboxStatus } from "./ses-sandbox.js";

describe("getSandboxStatus", () => {
  it("maps GetAccount response", async () => {
    const client = { send: async () => ({ ProductionAccessEnabled: false, SendingEnabled: true, SendQuota: { Max24HourSend: 200, MaxSendRate: 1, SentLast24Hours: 5 } }) };
    const s = await getSandboxStatus({ client });
    expect(s.productionAccess).toBe(false);
    expect(s.sendingEnabled).toBe(true);
    expect(s.max24HourSend).toBe(200);
    expect(s.sentLast24Hours).toBe(5);
  });
});

describe("requestProductionAccess", () => {
  it("submits PutAccountDetails with production access enabled", async () => {
    let input: any;
    const client = { send: async (cmd: any) => { input = cmd.input; return {}; } };
    const r = await requestProductionAccess({ websiteUrl: "https://example.com", useCaseDescription: "agent email" }, { client });
    expect(r.submitted).toBe(true);
    expect(input.ProductionAccessEnabled).toBe(true);
    expect(input.MailType).toBe("TRANSACTIONAL");
    expect(input.WebsiteURL).toBe("https://example.com");
  });
});

describe("describeSandboxStatus", () => {
  it("describes sandbox vs production", () => {
    expect(describeSandboxStatus({ productionAccess: false, sendingEnabled: true, max24HourSend: 200, maxSendRate: 1, sentLast24Hours: 0 })).toMatch(/SANDBOX/);
    expect(describeSandboxStatus({ productionAccess: true, sendingEnabled: true })).toMatch(/production access ENABLED/);
  });
});
