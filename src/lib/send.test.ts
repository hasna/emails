import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, resetDatabase } from "../db/database.js";
import { createProvider } from "../db/providers.js";
import { createAddress } from "../db/addresses.js";
import { suspendAddress } from "../db/address-lifecycle.js";
import { sendWithFailover } from "./send.js";

let providerId: string;
beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  providerId = createProvider({ name: "sandbox", type: "sandbox" }).id;
});
afterEach(() => { closeDatabase(); delete process.env["EMAILS_DB_PATH"]; });

describe("sendWithFailover — lifecycle guard", () => {
  it("blocks a send from a suspended address", async () => {
    const a = createAddress({ provider_id: providerId, email: "blocked@x.com" });
    suspendAddress(a.id);
    await expect(
      sendWithFailover(providerId, { from: "blocked@x.com", to: "y@x.com", subject: "hi", text: "yo" }),
    ).rejects.toThrow(/suspend/i);
  });

  it("blocks a send when the From has a display name and address is suspended", async () => {
    const a = createAddress({ provider_id: providerId, email: "blocked@x.com" });
    suspendAddress(a.id);
    await expect(
      sendWithFailover(providerId, { from: "Ops <blocked@x.com>", to: "y@x.com", subject: "hi", text: "yo" }),
    ).rejects.toThrow(/suspend/i);
  });

  it("allows a send from an active address", async () => {
    createAddress({ provider_id: providerId, email: "ok@x.com" });
    const r = await sendWithFailover(providerId, { from: "ok@x.com", to: "y@x.com", subject: "hi", text: "yo" });
    expect(r.providerId).toBe(providerId);
    expect(r.messageId).toBeTruthy();
  });
});
