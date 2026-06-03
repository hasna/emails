import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, resetDatabase } from "../db/database.js";
import { createProvider } from "../db/providers.js";
import { createAddress } from "../db/addresses.js";
import { suspendAddress } from "../db/address-lifecycle.js";
import { createOwner, assignAddressOwner } from "../db/owners.js";
import { createSendKey } from "../db/send-keys.js";
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

describe("sendWithFailover — scoped-auth guard", () => {
  it("a scoped key can send from an owned address", async () => {
    const agent = createOwner({ type: "agent", name: "Augustus" });
    const a = createAddress({ provider_id: providerId, email: "mine@x.com" });
    assignAddressOwner(a.id, agent.id);
    const { token } = createSendKey(agent.id);
    const r = await sendWithFailover(providerId, { from: "mine@x.com", to: "y@x.com", subject: "hi", text: "yo", auth_token: token });
    expect(r.messageId).toBeTruthy();
  });

  it("a scoped key cannot send from an address it does not own", async () => {
    const agent = createOwner({ type: "agent", name: "Commodus" });
    const a = createAddress({ provider_id: providerId, email: "mine@x.com" });
    assignAddressOwner(a.id, agent.id);
    createAddress({ provider_id: providerId, email: "victim@x.com" });
    const { token } = createSendKey(agent.id);
    await expect(
      sendWithFailover(providerId, { from: "victim@x.com", to: "y@x.com", subject: "hi", text: "yo", auth_token: token }),
    ).rejects.toThrow(/not authorized/i);
  });

  it("an invalid token is rejected", async () => {
    createAddress({ provider_id: providerId, email: "mine@x.com" });
    await expect(
      sendWithFailover(providerId, { from: "mine@x.com", to: "y@x.com", subject: "hi", text: "yo", auth_token: "esk_bogus" }),
    ).rejects.toThrow(/invalid|revoked/i);
  });

  it("no token = trusted local caller (no scoping)", async () => {
    createAddress({ provider_id: providerId, email: "any@x.com" });
    const r = await sendWithFailover(providerId, { from: "any@x.com", to: "y@x.com", subject: "hi", text: "yo" });
    expect(r.messageId).toBeTruthy();
  });
});
