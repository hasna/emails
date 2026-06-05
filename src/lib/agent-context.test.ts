import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, resetDatabase } from "../db/database.js";
import { createProvider } from "../db/providers.js";
import { createAddress, markVerified } from "../db/addresses.js";
import { createOwner, assignAddressOwner } from "../db/owners.js";
import { getEmailSystemStatus, getNextEmailAction } from "./agent-context.js";

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("agent context", () => {
  it("summarizes providers, verified senders, and ownership", () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    const address = markVerified(createAddress({ provider_id: provider.id, email: "ops@example.com" }).id);
    const owner = createOwner({ type: "agent", name: "agent" });
    assignAddressOwner(address.id, owner.id);

    const status = getEmailSystemStatus();

    expect(status.providers.total).toBe(1);
    expect(status.addresses.total).toBe(1);
    expect(status.addresses.owned).toBe(1);
    expect(status.addresses.usable_from[0]?.email).toBe("ops@example.com");
  });

  it("suggests wait-code for verification goals", () => {
    const next = getNextEmailAction("need verification code");
    expect(next).toMatchObject({ command: "emails inbox wait-code <address> --timeout 120" });
  });
});
