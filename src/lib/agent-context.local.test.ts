// LOCAL-mode honesty for the status payload.
//
// Two things are guarded here, both of which were wrong before:
//
// 1. The pre-fix assembler had no mode branch at all, so LOCAL mode published the
//    same hardcoded provider/domain/address/provisioning zeros as self-hosted.
//    These tests read a real local SQLite database and assert the real counts.
//
// 2. `degraded` must be usable as a gate. Local mode ALWAYS carries one
//    structurally-unanswerable block (`sources.configured` is a self-hosted server
//    inventory), so a definition of `degraded` that counted any gap pinned it to
//    true on every healthy install — a flag that is never green is a flag nobody
//    reads. Structural limits belong to `limited`/`limitations`; `degraded` is
//    reserved for read failures and lower-bound counts.
//
// 3. `next_actions` must only propose commands that RUN here. The self-hosted
//    guard (agent-context.self-hosted.test.ts) had no local mirror, so the
//    provisioning-failure branch proposed `emails provision status` in local mode
//    — a command that throws notImplementedAnywhere() in every mode. Advice that
//    refuses is the same defect class as a fabricated count.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "../db/database.js";
import { createProvider } from "../db/providers.local.js";
import { createDomain } from "../db/domains.local.js";
import { createAddress } from "../db/addresses.local.js";
import { setDomainProvisioning } from "../db/provisioning.local.js";
import { formatEmailSystemStatus, getEmailSystemStatus } from "./agent-context.js";
import { statusGapClass } from "./status-availability.js";
import { isCommandAvailableInMode } from "./status-commands.js";
import { cliRefusalFor } from "../test-support/cli-refusals.js";

const SELF_HOSTED_ENV = ["EMAILS_SELF_HOSTED_URL", "EMAILS_SELF_HOSTED_API_KEY", "EMAILS_CLIENT_ENV_SECRET"] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of SELF_HOSTED_ENV) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env["EMAILS_MODE"] = "local";
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  delete process.env["EMAILS_MODE"];
  for (const key of SELF_HOSTED_ENV) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function seed(): void {
  const db = getDatabase();
  const provider = createProvider({ name: "Sandbox", type: "sandbox" }, db);
  createDomain(provider.id, "alpha.example", db);
  createAddress({ provider_id: provider.id, email: "ops@alpha.example" }, db);
}

/** Seed one domain whose provisioning FAILED — the branch that proposes a remedy. */
function seedFailedProvisioning(): void {
  const db = getDatabase();
  const provider = createProvider({ name: "Sandbox", type: "sandbox" }, db);
  const domain = createDomain(provider.id, "broken.example", db);
  createAddress({ provider_id: provider.id, email: "ops@broken.example" }, db);
  setDomainProvisioning(domain.id, { provisioning_status: "failed", last_error: "DNS never propagated" }, db);
}

describe("local status payload", () => {
  it("counts the local database, never a hardcoded zero", async () => {
    seed();
    const status = await getEmailSystemStatus();

    expect(status.mode.current).toBe("local");
    expect(status.providers).toMatchObject({ total: 1, active: 1 });
    expect(status.providers.by_type).toEqual({ sandbox: 1 });
    expect(status.domains.total).toBe(1);
    expect(status.addresses.total).toBe(1);
    // Local mode OWNS these, so they are numbers here and null in self-hosted.
    expect(status.domains.send_ready).not.toBeNull();
    expect(status.domains.receive_ready).not.toBeNull();
    expect(status.addresses.usable_from).not.toBeNull();
    expect(status.inbox.inbound_buckets.items).not.toBeNull();
    expect(status.inbox.realtime.queue_configured).not.toBeNull();
  });

  it("is not degraded on a healthy install, and says what it cannot answer", async () => {
    seed();
    const status = await getEmailSystemStatus();

    expect(status.degraded).toBe(false);
    expect(status.failures).toEqual([]);
    expect(status.incomplete).toEqual([]);

    // ...but it is honest about the block it structurally cannot answer.
    expect(status.limited).toBe(true);
    expect(status.limitations).toContain("sources.configured.total");
    expect(status.sources.configured.total).toBeNull();
    expect(status.gaps["sources.configured.total"]?.reason)
      .toMatch(/^not_applicable:server_source_inventory/);

    for (const path of status.limitations) {
      expect(statusGapClass(status.gaps[path]?.reason), path).toBe("structural");
    }
    // The gap section is printed even though nothing failed.
    expect(formatEmailSystemStatus(status)).toContain("sources.configured.total — not_applicable");
  });

  it("distinguishes a MEASURED zero from an unmeasured field on an empty database", async () => {
    const status = await getEmailSystemStatus();

    // A real zero is a real answer: it stays 0, and its block stays available.
    expect(status.providers.total).toBe(0);
    expect(status.providers.availability.available).toBe(true);
    expect(status.providers.availability.basis).toBe("local_query");
    expect(status.unavailable).not.toContain("providers.total");
    // An empty install has nothing to report as a failure either.
    expect(status.degraded).toBe(false);
    // And next_actions is never a silent empty list.
    expect(status.next_actions.length).toBeGreaterThan(0);
  });

  // Mirror of the self-hosted guard in agent-context.self-hosted.test.ts. Without
  // it the provisioning-failure branch proposed `emails provision status` here,
  // which throws `... is not implemented in this build` in EVERY mode.
  it("never proposes a command that refuses in local mode", async () => {
    seedFailedProvisioning();
    const status = await getEmailSystemStatus();

    expect(status.provisioning.domains_failed).toBe(1);
    // The failure IS surfaced — this is not "stay silent to stay honest".
    expect(status.next_actions.some((action) => action.reason.includes("Provisioning failed"))).toBe(true);

    // ORACLE IS THE CLI, NOT THE REGISTRY. This used to assert
    // `isCommandAvailableInMode(action.command, "local")`, i.e. it validated the
    // payload against the very registry that filtered it — so a command missing
    // from the registry passed here and threw at the terminal. That is how
    // `emails domain check` (src/cli/commands/domain.ts serverOnly(), reached via
    // domain-readiness fix_commands) stayed green. cliRefusalFor() reads the
    // CLI's own call sites.
    const proposed = status.next_actions
      .map((action) => action.command)
      .filter((command): command is string => command !== null);
    expect(proposed.length, "the guard must have commands to check").toBeGreaterThan(0);
    const refused = proposed
      .map((command) => ({ command, prefix: cliRefusalFor(command, "local") }))
      .filter((entry) => entry.prefix !== null)
      .map((entry) => `${entry.command} (refused by ${entry.prefix})`);
    expect(refused, "next_actions proposes commands that throw in local mode").toEqual([]);
    expect(formatEmailSystemStatus(status)).not.toContain("emails provision status");
  });

  it("renders an unmeasured provisioning count as unavailable, never the word null", async () => {
    seedFailedProvisioning();
    const status = await getEmailSystemStatus();
    // Self-hosted can measure domain failures without address failures; the
    // renderer must not interpolate that null straight into the line.
    status.provisioning.addresses_failed = null;

    const rendered = formatEmailSystemStatus(status);
    expect(rendered).toContain("Provisioning failures:");
    expect(rendered).not.toContain("null address(es)");
    expect(rendered).toContain("unavailable address(es)");
  });
});
