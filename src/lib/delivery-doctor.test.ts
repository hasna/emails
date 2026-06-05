import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, resetDatabase } from "../db/database.js";
import { createProvider } from "../db/providers.js";
import { createAddress } from "../db/addresses.js";
import { createOwner, assignAddressOwner } from "../db/owners.js";
import { setAddressProvisioning } from "../db/provisioning.js";
import { diagnoseInboundDelivery } from "./delivery-doctor.js";

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("delivery doctor", () => {
  it("reports configured address ownership and receive readiness", () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    const address = createAddress({ provider_id: provider.id, email: "ops@example.com" });
    const owner = createOwner({ type: "agent", name: "agent" });
    assignAddressOwner(address.id, owner.id);
    setAddressProvisioning(address.id, { provisioning_status: "ready" });

    const report = diagnoseInboundDelivery("ops@example.com");

    expect(report.checks.some((check) => check.name === "Configured address" && check.status === "pass")).toBe(true);
    expect(report.checks.some((check) => check.name === "Ownership" && check.status === "pass")).toBe(true);
    expect(report.checks.some((check) => check.name === "Address receive readiness" && check.status === "pass")).toBe(true);
  });
});
