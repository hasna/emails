// The one decision `emails serve` makes about the optional provider webhook listener.
//
// WHY THIS FILE EXISTS AT ALL, given that this command had no test before: the webhook receiver now
// REFUSES on an installation whose mail lives in an Emails API (`src/lib/webhook.ts`), and that
// refusal reaches `emails serve`. The command's action cannot be driven end to end — its first
// statement calls `startServer`, which returns `Promise<void>` and gives no handle, so a dashboard
// bound by a test would hold the port and the event loop for the rest of the run — so the decision
// is a named, returned-result unit and this file exercises that unit.
//
// EVERY STORAGE SETTING IS NAMED THROUGH THE RESOLVER'S OWN CONSTANTS, so this file configures
// storage without naming the deployment word, which is a counter that may only fall.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import {
  API_BASE_URL_SETTING,
  API_CREDENTIAL_SETTINGS,
  API_SETTINGS_POINTER,
  DATABASE_PATH_SETTINGS,
} from "../../store-resolution.js";
import { startServeWebhookListener } from "./serve.local.js";

let INHERITED_PROCESS_ENV: NodeJS.ProcessEnv;
let home: string;

function clearStoreSettings(): void {
  for (const setting of [API_BASE_URL_SETTING, API_SETTINGS_POINTER, ...API_CREDENTIAL_SETTINGS]) {
    delete process.env[setting];
  }
  for (const setting of DATABASE_PATH_SETTINGS) delete process.env[setting];
}

beforeEach(() => {
  INHERITED_PROCESS_ENV = { ...process.env };
  home = mkdtempSync(join(tmpdir(), "serve-home-"));
  process.env["HOME"] = home;
  clearStoreSettings();
  process.env[DATABASE_PATH_SETTINGS[1]] = ":memory:";
  resetDatabase();
  getDatabase();
});

afterEach(() => {
  closeDatabase();
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
  rmSync(home, { recursive: true, force: true });
});

describe("startServeWebhookListener", () => {
  it("REPORTS the refusal instead of throwing, so a bound dashboard is not taken down with it", async () => {
    clearStoreSettings();
    process.env[API_BASE_URL_SETTING] = "https://mail.example.test";
    process.env[API_CREDENTIAL_SETTINGS[0]] = "not-a-real-credential";

    const outcome = await startServeWebhookListener(9877, "provider-1", undefined);
    expect(outcome.started).toBe(false);
    if (outcome.started) throw new Error("the listener started on an API-configured installation");
    // The reason has to be actionable, not merely present.
    expect(outcome.reason).toContain("durable provider webhook receiver runs where the mail is stored");
    expect(outcome.reason).toContain(API_BASE_URL_SETTING);
  });

  it("STARTS on a local database and hands back a handle that really stops the listener", async () => {
    const outcome = await startServeWebhookListener(0, "provider-1", undefined);
    expect(outcome.started).toBe(true);
    if (!outcome.started) throw new Error(`the listener did not start: ${outcome.reason}`);

    // THE HANDLE IS ASSERTED BY USE, not by shape. `typeof stop === "function"` passes for a
    // no-op — a mutation that discarded the real server and returned an empty `stop` survived
    // exactly that assertion while leaking the listener. So: prove it was listening, stop it, and
    // prove it is not.
    const server = outcome.server;
    expect(server.port).toBeGreaterThan(0);
    const before = await fetch(`http://127.0.0.1:${server.port}/webhook/nowhere`, { method: "POST", body: "{}" });
    expect(before.status).toBe(404);

    server.stop(true);
    const after = await fetch(`http://127.0.0.1:${server.port}/webhook/nowhere`, { method: "POST", body: "{}" })
      .then(() => "still-listening")
      .catch(() => "stopped");
    expect(after).toBe("stopped");
  });

  it("REPORTS a bind failure the same way, so the caller has one shape to handle", async () => {
    const occupied = Bun.serve({ port: 0, fetch: () => new Response("busy") });
    try {
      const outcome = await startServeWebhookListener(occupied.port, "provider-1", undefined);
      expect(outcome.started).toBe(false);
      if (outcome.started) { outcome.server.stop(true); throw new Error("two listeners bound the same port"); }
      // Not the storage refusal — a different failure, reported through the same channel.
      expect(outcome.reason).not.toContain("durable provider webhook receiver runs where the mail is stored");
      expect(outcome.reason.length).toBeGreaterThan(0);
    } finally {
      occupied.stop(true);
    }
  });
});
