// The doctor family has ONE implementation, and it reads every resource fact through the
// store seam.
//
// The family used to be a facade over two modules that produced DIFFERENT REPORTS from
// the same call: one opened the local SQLite database and counted rows with
// `SELECT COUNT(*)`, the other never touched a database and probed the operator service's
// `/health` and `/ready`. An environment variable decided which report an operator — or an
// agent, through the MCP `run_doctor` tool — was shown.
//
// What replaces that pick is the store's own answer, and for a DIAGNOSTIC the hard part is
// not reading the answer but refusing to improve on it. So the tests that matter most here
// are the ones that pin what this file must NEVER do:
//
//   * report `pass` for something it could not check;
//   * report a count of 0, or an empty list, where the honest answer is "I could not look";
//   * print a page prefix as if it were a total;
//   * infer that a store is reachable from the fact that it refused.
//
// This repo has shipped every one of those. `Self-hosted API: pass` because a client
// configuration PARSED, with no request ever made, was this very module.

import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, resetDatabase, type Database } from "../db/database.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import type { EmailStore } from "../store/email-store.js";
import type { Outcome, Refusal } from "../store/outcome.js";
import type { DomainRecord, ResourceRow } from "../store/records.js";
import {
  LOCAL_REFUSED_COMMANDS,
  NEVER_AVAILABLE_COMMANDS,
  SELF_HOSTED_REFUSED_COMMANDS,
} from "./status-commands.js";
import { runDiagnostics, formatDiagnostics } from "./doctor.js";
import type { DoctorCheck } from "./doctor.js";

const libDir = import.meta.dir;
const repoRoot = join(libDir, "..", "..");

/** The subjects that have no source other than the store. */
const STORE_BACKED = ["Store capabilities", "Providers", "Domains", "Addresses", "Contacts", "Templates"] as const;

let INHERITED_PROCESS_ENV: NodeJS.ProcessEnv;
function captureInheritedProcessEnv(): void {
  INHERITED_PROCESS_ENV = { ...process.env };
}
function restoreInheritedProcessEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
}

// Storage and credential settings this suite must control rather than inherit. The AWS
// ones matter as much as the storage ones: with them set, the provisioning check reports a
// real environment credential and the "not observable" assertions become vacuous.
const CONTROLLED_ENV = [
  "HASNA_EMAILS_DB_PATH",
  "EMAILS_DB_PATH",
  "EMAILS_SELF_HOSTED_URL",
  "EMAILS_SELF_HOSTED_API_KEY",
  "EMAILS_CLIENT_ENV_SECRET",
  "EMAILS_SESSION_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_PROFILE",
  "AWS_REGION",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_EMAIL",
  "CLOUDFLARE_ACCOUNT_ID",
  "RESEND_API_KEY",
] as const;

let db: Database;
let tempHome: string;

beforeEach(() => {
  captureInheritedProcessEnv();
  tempHome = mkdtempSync(join(tmpdir(), "emails-doctor-test-home-"));
  process.env["HOME"] = tempHome;
  for (const key of CONTROLLED_ENV) delete process.env[key];
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  db = getDatabase();
});

afterEach(() => {
  closeDatabase();
  restoreInheritedProcessEnv();
  rmSync(tempHome, { recursive: true, force: true });
});

/** A real store over the test database. Everything below builds on this one. */
function realStore(): EmailStore {
  return createSqliteEmailStore({ database: db, detail: "SQLite in-memory (doctor test)" });
}

/**
 * The real store with ONE repository method replaced — the neutering pattern the store
 * suites use. A hand-rolled partial store cast to `EmailStore` would let a signature drift
 * without `tsc` noticing; this cannot, because `base` is checked against the seam.
 */
function storeAnswering<TFamily extends "providers" | "contacts" | "templates">(
  family: TFamily,
  answer: Outcome<ResourceRow[]> | (() => Promise<Outcome<ResourceRow[]>>),
): EmailStore {
  const base = realStore();
  const list = typeof answer === "function" ? answer : async () => answer;
  return { ...base, [family]: { ...base[family], list } } as EmailStore;
}

/**
 * A family that PAGES like a store: it honours `limit`/`offset` over a fixed row set, so an
 * enumeration reaches an empty page and terminates. `clamp` serves fewer rows per request
 * than were asked for, which is the pathological case a short page must not be mistaken for
 * the end of.
 */
function storeServing<TFamily extends "providers" | "contacts" | "templates">(
  family: TFamily,
  rows: ResourceRow[],
  clamp = Number.POSITIVE_INFINITY,
): EmailStore {
  const base = realStore();
  const list = async (opts?: { limit?: number; offset?: number }): Promise<Outcome<ResourceRow[]>> => {
    const offset = opts?.offset ?? 0;
    const limit = Math.min(opts?.limit ?? rows.length, clamp);
    return { ok: true, value: rows.slice(offset, offset + limit) };
  };
  return { ...base, [family]: { ...base[family], list } } as EmailStore;
}

/** Serves a full page forever, so an enumeration exhausts its budget without ending. */
function storeServingEndlessProviders(): EmailStore {
  const base = realStore();
  return {
    ...base,
    providers: {
      ...base.providers,
      list: async (opts?: { limit?: number }) => ({ ok: true, value: providerRows(opts?.limit ?? 500) }),
    },
  };
}

function storeAnsweringDomainsWith(answer: Outcome<DomainRecord[]>): EmailStore {
  const base = realStore();
  return { ...base, domains: { ...base.domains, listDomains: async () => answer } };
}

function storeServingDomains(rows: DomainRecord[]): EmailStore {
  const base = realStore();
  return {
    ...base,
    domains: {
      ...base.domains,
      listDomains: async (opts?: { limit?: number; offset?: number }) => {
        const offset = opts?.offset ?? 0;
        return { ok: true as const, value: rows.slice(offset, offset + (opts?.limit ?? rows.length)) };
      },
    },
  };
}

/** Serves a full page of domains forever. */
function storeServingEndlessDomains(domain: (id: string) => DomainRecord): EmailStore {
  const base = realStore();
  return {
    ...base,
    domains: {
      ...base.domains,
      listDomains: async (opts?: { limit?: number }) => ({
        ok: true as const,
        value: Array.from({ length: opts?.limit ?? 500 }, (_unused, index) => domain(`d-${index}`)),
      }),
    },
  };
}

/** A store where every subject this diagnostic reads refuses, with the same code. */
function storeRefusingEverything(refusal: Refusal): EmailStore {
  const base = realStore();
  return {
    ...base,
    providers: { ...base.providers, list: async () => refusal },
    contacts: { ...base.contacts, list: async () => refusal },
    templates: { ...base.templates, list: async () => refusal },
    domains: { ...base.domains, listDomains: async () => refusal },
    addresses: { ...base.addresses, listAddresses: async () => refusal },
  };
}

const CAPABILITY_REFUSAL: Refusal = {
  ok: false,
  code: "capability_unavailable",
  message: "the test store does not provide this family",
  status: 501,
};

function named(checks: DoctorCheck[], name: string): DoctorCheck {
  const found = checks.find((check) => check.name === name);
  if (found === undefined) {
    throw new Error(`no check named ${name}; got ${checks.map((check) => check.name).join(", ")}`);
  }
  return found;
}

async function seedProviders(count: number): Promise<void> {
  const store = realStore();
  for (let index = 0; index < count; index += 1) {
    const created = await store.providers.create({ name: `sandbox-${index}`, type: "sandbox", active: 1 });
    if (!created.ok) throw new Error(`could not seed a provider: ${created.message}`);
  }
}

function providerRows(count: number): ResourceRow[] {
  return Array.from({ length: count }, (_unused, index) => ({ id: `p-${index}`, name: `p-${index}`, type: "sandbox" }));
}

// ─── STRUCTURE ────────────────────────────────────────────────────────────────────────
//
// These read the tree rather than run the code, because "there is one implementation" is a
// claim about files and imports that no behavioural test can make.

/**
 * The second-implementation arms of one family, given a directory listing.
 *
 * The predicate RESOLVES THE FACADE SIBLING rather than pattern-matching the suffix, which
 * is the finding the batch collapse recorded: `sent-ledger.local.ts` has no facade and no
 * sibling arm, so a guard that flagged every `.local.` file would have to be relaxed by
 * name — and a guard relaxed by name stops guarding. A `.local` module is an ARM only when
 * an `x.ts` facade exists beside it.
 */
function armModulesFor(stem: string, entries: string[]): string[] {
  const extensions = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"];
  const hasFacade = extensions.some((extension) => entries.includes(`${stem}.${extension}`));
  if (!hasFacade) return [];
  return entries
    .filter((entry) => entry.startsWith(`${stem}.`))
    .filter((entry) => {
      const parts = entry.split(".");
      if (parts.length !== stem.split(".").length + 2) return false;
      const arm = parts[parts.length - 2];
      return arm !== undefined && arm !== "test" && extensions.includes(parts[parts.length - 1] as string);
    })
    .sort();
}

describe("the doctor family's structure", () => {
  it("ships no second implementation arm beside the facade", () => {
    const entries = readdirSync(join(repoRoot, "src", "lib"));

    expect(armModulesFor("doctor", entries)).toEqual([]);
    expect(entries).toContain("doctor.ts");
  });

  it("uses an arm predicate that fires on arms and not on look-alikes", () => {
    // POSITIVE CONTROL, both directions, against fixtures rather than repo content — the
    // repo count is supposed to be zero, so a "this predicate found something" assertion
    // over the tree would have to be deleted exactly when it starts mattering.
    const withArms = ["doctor.ts", "doctor.local.ts", "doctor.remote.ts", "doctor.test.ts"];
    expect(armModulesFor("doctor", withArms)).toEqual(["doctor.local.ts", "doctor.remote.ts"]);

    // A `.local` module with NO facade sibling is not an arm.
    expect(armModulesFor("sent-ledger", ["sent-ledger.local.ts"])).toEqual([]);

    // Another family's arms are not this family's, however similar the name looks.
    const neighbour = ["doctor.ts", "delivery-doctor.ts", "delivery-doctor.local.ts", "delivery-doctor.remote.ts"];
    expect(armModulesFor("doctor", neighbour)).toEqual([]);
    expect(armModulesFor("delivery-doctor", neighbour)).toEqual([
      "delivery-doctor.local.ts",
      "delivery-doctor.remote.ts",
    ]);

    // A test file beside a facade is not an arm.
    expect(armModulesFor("doctor", ["doctor.ts", "doctor.test.ts"])).toEqual([]);
  });

  it("reaches past no facade into an arm, and reads no deployment-mode module", () => {
    const source = readFileSync(join(libDir, "doctor.ts"), "utf8");
    const specifiers = [...source.matchAll(/from\s+"([^"]+)"|import\("([^"]+)"\)/g)]
      .map((match) => match[1] ?? match[2])
      .filter((specifier): specifier is string => specifier !== undefined);

    expect(specifiers.length).toBeGreaterThan(5);
    expect(specifiers.filter((specifier) => /\.(local|remote)\.js$/.test(specifier))).toEqual([]);
    // The process-wide deployment-mode module, named by path so this file contributes
    // nothing to the axis ratchet's own counters.
    expect(specifiers.filter((specifier) => /(^|\/)mode\.js$/.test(specifier))).toEqual([]);
  });

  it("is no longer reached through an arm by the CLI or the dashboard route", () => {
    const consumers = [
      join(repoRoot, "src", "cli", "commands", "misc.local.ts"),
      join(repoRoot, "src", "cli", "commands", "misc.remote.ts"),
      join(repoRoot, "src", "server", "routes", "inbound-sequences.ts"),
      join(repoRoot, "src", "mcp", "tools", "misc-ops.ts"),
      join(repoRoot, "src", "index.ts"),
    ];
    for (const consumer of consumers) {
      const source = readFileSync(consumer, "utf8");
      expect(source, `${consumer} must not import a doctor arm`).not.toMatch(/lib\/doctor\.(local|remote)\.js/);
      // Positive control for the assertion above: the pattern it uses does match the
      // specifier it is looking for, so a green run is not a broken regex.
      expect('await import("../../lib/doctor.local.js")').toMatch(/lib\/doctor\.(local|remote)\.js/);
    }
  });
});

// ─── REFUSALS, UNKNOWNS AND BOUNDS ────────────────────────────────────────────────────

describe("runDiagnostics reports what it could not check", () => {
  it("reads every resource fact from the store it was given, not from the process database", async () => {
    // Three providers in the process-wide database, seven in the injected store. Only one
    // of those numbers can be reported, and it has to be the store's.
    await seedProviders(3);

    const checks = await runDiagnostics({ _store: storeServing("providers", providerRows(7)) });

    expect(named(checks, "Providers").message).toContain("7 provider(s) configured");
    expect(named(checks, "Providers").message).not.toContain("3 provider(s)");
  });

  it("reports a capability refusal as unknown, naming the code, never as a count of zero", async () => {
    const checks = await runDiagnostics({ _store: storeAnswering("providers", CAPABILITY_REFUSAL) });
    const providers = named(checks, "Providers");

    expect(providers.status).toBe("unknown");
    expect(providers.message).toContain("capability_unavailable");
    expect(providers.message).toContain("HTTP 501");
    expect(providers.message).not.toContain("No providers configured");
    expect(providers.message).not.toMatch(/\b0 provider/);
  });

  it("does not call a store reachable because it refused", async () => {
    // The HTTP store decides a capability refusal LOCALLY, without sending a request. So a
    // refusal proves nothing about reachability, and `pass` here would be the same
    // fabricated green light this module shipped when a parsed config was reported as a
    // passing API check.
    const checks = await runDiagnostics({ _store: storeRefusingEverything(CAPABILITY_REFUSAL) });

    expect(named(checks, "Store").status).toBe("unknown");
    expect(named(checks, "Store").message).toContain("says nothing about whether it can be reached");
    // Not `fail` either: "it refused" is not evidence of a broken transport any more than it
    // is evidence of a working one.
    expect(named(checks, "Store").status).not.toBe("fail");
  });

  it("does not call a store unreachable because one family's read faulted", async () => {
    // Adversarial review of this collapse: reachability used to be inferred from the
    // providers read ALONE, so one malformed provider row reported `Store: fail` for a store
    // that was answering everything else — a false FAILURE that sends an operator to debug
    // their transport instead of their data.
    const checks = await runDiagnostics({
      _store: storeAnswering("providers", async () => {
        throw new Error("a stored provider row is malformed");
      }),
    });

    expect(named(checks, "Providers").status).toBe("fail");
    expect(named(checks, "Store").status).toBe("pass");
    expect(named(checks, "Store").message).toContain("A read was served by");
  });

  it("calls a store unreachable only when every read against it failed", async () => {
    const base = realStore();
    const faulted = async (): Promise<never> => {
      throw new Error("the connection was refused");
    };
    const checks = await runDiagnostics({
      _store: {
        ...base,
        providers: { ...base.providers, list: faulted },
        contacts: { ...base.contacts, list: faulted },
        templates: { ...base.templates, list: faulted },
        domains: { ...base.domains, listDomains: faulted },
        addresses: { ...base.addresses, listAddresses: faulted },
      },
    });

    expect(named(checks, "Store").status).toBe("fail");
    expect(named(checks, "Store").message).toContain("Every read against");
    for (const subject of STORE_BACKED) {
      if (subject === "Store capabilities") continue;
      expect(named(checks, subject).status, subject).toBe("fail");
    }
  });

  it("reports a suppression column the rows do not carry as unknown, not as zero suppressed", async () => {
    // Adversarial review: an ABSENT column read the same as a NULL one, so a store whose
    // contact rows simply do not carry `suppressed` reported "(0 suppressed)" — a fabricated
    // zero about the one number here that decides whether someone gets mailed who asked not
    // to be. A present-but-null value still counts as not suppressed, matching the SQL the
    // deleted arm used.
    const absent = await runDiagnostics({
      _store: storeServing("contacts", [{ id: "c-1", email: "one@example.test" }]),
    });
    expect(named(absent, "Contacts").status).toBe("unknown");
    expect(named(absent, "Contacts").message).not.toContain("(0 suppressed)");

    const explicitNull = await runDiagnostics({
      _store: storeServing("contacts", [{ id: "c-1", email: "one@example.test", suppressed: null }]),
    });
    expect(named(explicitNull, "Contacts")).toMatchObject({ status: "pass", message: "1 contacts (0 suppressed)" });
  });

  it("reports a non-capability refusal as a failure rather than as an unknown", async () => {
    const checks = await runDiagnostics({
      _store: storeAnsweringDomainsWith({
        ok: false,
        code: "scope_violation",
        message: "the caller's scope does not include these domains",
        status: 403,
      }),
    });
    const domains = named(checks, "Domains");

    expect(domains.status).toBe("fail");
    expect(domains.message).toContain("scope_violation");
    expect(domains.message).not.toMatch(/\b0\/0\b/);
  });

  it("reports a fault as a failure, distinct from a refusal", async () => {
    const checks = await runDiagnostics({
      _store: storeAnswering("templates", async () => {
        throw new Error("the connection went away mid-read");
      }),
    });
    const templates = named(checks, "Templates");

    expect(templates.status).toBe("fail");
    expect(templates.message).toContain("the connection went away mid-read");
    expect(templates.message).not.toMatch(/\b0 template/);
  });

  it("reports an enumeration that never reached the end as a lower bound, not as a total", async () => {
    // The seam has no count operation, so a count is assembled by enumerating. A store that
    // keeps serving full pages exhausts the page budget without ever answering an empty page,
    // and at that point the observed count is a FLOOR. Printing it would be a total nobody
    // measured.
    const checks = await runDiagnostics({ _store: storeServingEndlessProviders() });
    const providers = named(checks, "Providers");

    expect(providers.status).toBe("unknown");
    expect(providers.message).toContain("at least 2000");
    expect(providers.message).toContain("no count operation");
    expect(providers.message).toContain("did not reach the end");
    expect(providers.message).not.toMatch(/^2000 provider/);
  });

  it("does not mistake a SHORT page for the end of the table", async () => {
    // The hazard this design exists for: a store may serve fewer rows than were asked for —
    // a lower internal clamp, a proxy, a future implementation — and a scan that stopped on
    // the first short page would publish that clamp as a complete total. Here 250 rows are
    // served 100 at a time against a 500-row request. The answer must be 250.
    const checks = await runDiagnostics({ _store: storeServing("providers", providerRows(250), 100) });

    expect(named(checks, "Providers")).toMatchObject({ status: "pass", message: "250 provider(s) configured" });
    expect(named(checks, "Providers").message).not.toContain("100 provider");
  });

  it("counts exactly when the enumeration reaches an empty page, even at the page size", async () => {
    // Exactly one full page followed by an empty one IS an exact answer, and must not be
    // downgraded to "at least 500" just because the first page was full.
    const checks = await runDiagnostics({ _store: storeServing("providers", providerRows(500)) });

    expect(named(checks, "Providers")).toMatchObject({ status: "pass", message: "500 provider(s) configured" });
    expect(named(checks, "Providers").message).not.toContain("at least");
  });

  it("suppresses a proportion as well as a total when the enumeration did not finish", async () => {
    const domain = (id: string): DomainRecord => ({
      id,
      domain: `${id}.test`,
      status: "verified",
      provider: null,
      verified: true,
      notes: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    const checks = await runDiagnostics({ _store: storeServingEndlessDomains(domain) });

    // "2000/2000 domains verified" would read as "everything is verified" off a prefix that
    // says nothing about row 2001.
    expect(named(checks, "Domains").status).toBe("unknown");
    expect(named(checks, "Domains").message).not.toContain("2000/2000");
    expect(named(checks, "Domains").message).toContain("at least 2000");
  });

  it("reports an unreadable suppression flag as unknown rather than as zero suppressed", async () => {
    const checks = await runDiagnostics({
      _store: storeServing("contacts", [{ id: "c-1", email: "one@example.test", suppressed: "maybe" }]),
    });
    const contacts = named(checks, "Contacts");

    expect(contacts.status).toBe("unknown");
    expect(contacts.message).toContain("not observable");
    expect(contacts.message).not.toContain("(0 suppressed)");
  });

  it("never answers a store that refuses everything with a pass or a zero", async () => {
    const checks = await runDiagnostics({ _store: storeRefusingEverything(CAPABILITY_REFUSAL) });

    for (const subject of STORE_BACKED) {
      if (subject === "Store capabilities") continue; // declared locally, not read
      const check = named(checks, subject);
      expect(check.status, `${subject} must not pass`).not.toBe("pass");
      expect(check.message, `${subject} must name the refusal`).toContain("capability_unavailable");
      expect(check.message, `${subject} must not report a zero`).not.toMatch(/(?:^|\s)0(?:\s|$|\/)/);
      expect(check.message, `${subject} must not report an empty list`).not.toMatch(/\bNo (?:providers|domains)\b/);
    }
  });

  it("says outright that it lost the deleted arm's readiness probe rather than dropping the check", async () => {
    // The deleted API arm probed `GET /ready` and reported `pendingMigrations`. The seam has
    // no readiness operation, so the signal is gone — and a shorter report is exactly how a
    // lost check disappears unnoticed.
    for (const store of [realStore(), storeAnswering("providers", CAPABILITY_REFUSAL)]) {
      const readiness = named(await runDiagnostics({ _store: store }), "Store readiness");
      expect(readiness.status).toBe("unknown");
      expect(readiness.message).toContain("no readiness operation");
      expect(readiness.message).toContain("/ready");
    }
  });

  it("reports the store's declared-unavailable capabilities instead of hiding them", async () => {
    const checks = await runDiagnostics({ _store: realStore() });
    const capabilities = named(checks, "Store capabilities");

    // The local SQLite store declares the ledger unavailable; an operator reading doctor
    // output should learn that here rather than when a send refuses.
    expect(capabilities.status).toBe("warn");
    expect(capabilities.message).toContain("sendIntentLedger");
    expect(capabilities.message).toContain("Declared, not broken");
  });
});

// ─── THE CONFIGURATION ITSELF ─────────────────────────────────────────────────────────

describe("runDiagnostics and the storage configuration", () => {
  it("reports a configuration that names both a local database and an API as a failing check", async () => {
    // A doctor is the tool an operator runs BECAUSE the configuration is broken, so the
    // resolver's boot error has to become part of the report rather than replace it.
    process.env["EMAILS_DB_PATH"] = join(tempHome, "emails.db");
    process.env["EMAILS_SELF_HOSTED_URL"] = "https://mail.example.test";
    process.env["EMAILS_SELF_HOSTED_API_KEY"] = "test-key";

    const checks = await runDiagnostics();
    const store = named(checks, "Store");

    expect(store.status).toBe("fail");
    expect(store.message).toContain("no way to tell which one you meant");
    expect(store.message).toContain("EMAILS_DB_PATH");
    expect(store.message).toContain("EMAILS_SELF_HOSTED_URL");

    // And every subject the store would have answered says so, rather than vanishing from
    // the report or reporting a zero.
    for (const subject of STORE_BACKED) {
      expect(named(checks, subject).status, subject).toBe("unknown");
      expect(named(checks, subject).message, subject).toContain("no store could be constructed");
    }
    expect(checks.filter((check) => check.status === "pass").map((check) => check.name)).not.toContain("Store");
  });

  it("refuses a caller-supplied database handle instead of reporting on a store it is not", async () => {
    // The parameter existed so the deleted local arm could count rows in a specific SQLite
    // connection. Nothing here can honour that, and ignoring it silently would let a caller
    // believe the report described the handle it passed.
    const handle = { query: () => ({ get: () => ({}), all: () => [] }) } as unknown as Database;

    await expect(runDiagnostics(handle)).rejects.toThrow("no longer accepts a database handle");
  });

  it("keeps the arity its consumers call it with", async () => {
    // `runDiagnostics(undefined, opts)` is what the CLI, the dashboard route and the SDK
    // re-export all pass. It must keep meaning "these options".
    const checks = await runDiagnostics(undefined, { _store: storeServing("providers", providerRows(2)) });

    expect(named(checks, "Providers").message).toContain("2 provider(s) configured");
  });

  it("opens no local database when it was handed a store", async () => {
    // The database path is unset and the memoised connection dropped ON PURPOSE, so that
    // anything reaching for the process-wide database resolves the DEFAULT path and CREATES
    // a file under this test's HOME. Without that, `EMAILS_DB_PATH=:memory:` makes this
    // assertion hold whether or not the code under test opens a database — a test that
    // passes with the production change reverted, which is no test at all.
    const store = realStore();
    delete process.env["EMAILS_DB_PATH"];
    resetDatabase();

    await runDiagnostics({ _store: store });

    expect(existsSync(join(tempHome, ".hasna", "emails", "emails.db"))).toBe(false);
  });
});

// ─── THE CHECKS THAT ARE NOT STORE QUESTIONS ──────────────────────────────────────────

describe("runDiagnostics and the facts the seam does not carry", () => {
  it("reports provider credential validation as not observable, never as a pass", async () => {
    const checks = await runDiagnostics({ _store: realStore(), liveProviderChecks: true });
    const credentials = named(checks, "Provider credentials");

    expect(credentials.status).toBe("unknown");
    expect(credentials.message).toContain("cannot be performed");
    expect(credentials.message).toContain("redacts provider sending credentials");
  });

  it("recommends a command that actually performs the check it defers", async () => {
    const checks = await runDiagnostics({ _store: realStore() });
    const recommended = "emails provider status";

    expect(named(checks, "Provider credentials").message).toContain(recommended);
    // Recommending a command that refuses is the same defect class as reporting a count
    // nobody measured — see the header of status-commands.test.ts.
    for (const refused of [...LOCAL_REFUSED_COMMANDS, ...SELF_HOSTED_REFUSED_COMMANDS, ...NEVER_AVAILABLE_COMMANDS]) {
      expect(recommended.startsWith(refused), `${recommended} must not be refused by ${refused}`).toBe(false);
    }
  });

  it("reports stored SES provisioning credentials as unknown rather than as absent", async () => {
    const checks = await runDiagnostics({ _store: realStore() });
    const aws = named(checks, "Provisioning: aws");

    // With no AWS credentials in the environment, whether SES keys are stored on a provider
    // row decides this verdict — and that fact lives in the columns the seam redacts.
    // `fail` with "Set AWS_PROFILE" would be a fabricated negative.
    expect(aws.status).toBe("unknown");
    expect(aws.message).toContain("not observable");
    expect(aws.message).toContain("emails provider status");
  });

  it("still reports an environment AWS credential as configured", async () => {
    process.env["AWS_PROFILE"] = "doctor-test";

    const checks = await runDiagnostics({ _store: realStore() });

    // Positive control for the unknown above: an observable credential must not be
    // swallowed by the unknown path.
    expect(named(checks, "Provisioning: aws").status).toBe("pass");
    expect(named(checks, "Provisioning: aws").message).toContain("profile:doctor-test");
  });

  it("reports a config directory it cannot read instead of taking the whole report down with it", async () => {
    // Found by adversarial review of this collapse. `loadConfig()` does I/O — it creates and
    // hardens the data directory before reading — and it throws when that cannot be done.
    // Unguarded, that replaced the ENTIRE diagnosis, including the checks that had already
    // succeeded, with a stack trace: in the one command an operator runs to find out what is
    // broken. Here `~/.hasna` is a FILE, so creating `~/.hasna/emails` under it fails.
    writeFileSync(join(tempHome, ".hasna"), "not a directory");

    const checks = await runDiagnostics({ _store: realStore() });

    // The report survives, the checks that could be made were made, and the one that could
    // not says why.
    expect(named(checks, "Store").status).toBe("pass");
    expect(named(checks, "Templates").status).toBe("pass");
    expect(named(checks, "Provisioning: config").status).toBe("fail");
    expect(named(checks, "Provisioning: config").message).toContain("could not be read");
    // And it does not silently answer the credential questions it never got to ask.
    expect(checks.some((check) => check.name.startsWith("Provisioning: ") && check.status === "fail" && check.name !== "Provisioning: config")).toBe(false);
  });

  it("emits no SES account-status check when there is nothing to ask AWS with", async () => {
    const checks = await runDiagnostics({ _store: realStore() });

    expect(checks.some((check) => check.name === "SES Sending")).toBe(false);
  });
});

// ─── PARITY WITH THE DELETED LOCAL ARM ────────────────────────────────────────────────
//
// DECLARED PARITY COVERAGE, not change detectors: these exist to prove the collapse did
// not lose what the local arm reported, and most of them pass on `main` for that reason.

describe("runDiagnostics parity", () => {
  it("counts providers, contacts and templates from a store that serves them", async () => {
    const store = realStore();
    await seedProviders(2);
    const contact = await store.contacts.create({ email: "one@example.test" });
    if (!contact.ok) throw new Error(contact.message);
    const template = await store.templates.create({ name: "welcome", subject_template: "hi" });
    if (!template.ok) throw new Error(template.message);

    const checks = await runDiagnostics({ _store: store });

    expect(named(checks, "Store").status).toBe("pass");
    expect(named(checks, "Providers")).toMatchObject({ status: "pass", message: "2 provider(s) configured" });
    expect(named(checks, "Contacts")).toMatchObject({ status: "pass", message: "1 contacts (0 suppressed)" });
    expect(named(checks, "Templates")).toMatchObject({ status: "pass", message: "1 template(s)" });
  });

  it("warns when nothing is configured, without claiming it could not look", async () => {
    const checks = await runDiagnostics({ _store: realStore() });

    expect(named(checks, "Providers")).toMatchObject({ status: "warn", message: "No providers configured" });
    expect(named(checks, "Domains")).toMatchObject({ status: "warn", message: "No domains configured" });
    expect(named(checks, "Addresses")).toMatchObject({ status: "warn", message: "0 sender address(es)" });
  });

  it("warns that unverified senders are blocked and names the discovery command", async () => {
    const store = realStore();
    await seedProviders(1);
    const ready = await store.addresses.createAddress({ email: "ready@example.test", verified: true });
    const blocked = await store.addresses.createAddress({ email: "blocked@example.test", verified: false });
    if (!ready.ok) throw new Error(ready.message);
    if (!blocked.ok) throw new Error(blocked.message);

    const check = named(await runDiagnostics({ _store: store }), "Addresses");

    expect(check.status).toBe("warn");
    expect(check.message).toContain("1/2 sender address(es) verified");
    expect(check.message).toContain("sender_unverified");
    expect(check.message).toContain("emails address list --unverified");
  });

  it("counts a suppressed contact as a warning", async () => {
    const checks = await runDiagnostics({
      _store: storeServing("contacts", [
        { id: "c-1", email: "one@example.test", suppressed: 0 },
        { id: "c-2", email: "two@example.test", suppressed: 1 },
      ]),
    });

    expect(named(checks, "Contacts")).toMatchObject({ status: "warn", message: "2 contacts (1 suppressed)" });
  });

  it("passes the domain check only when every domain is verified", async () => {
    const domain = (id: string, verified: boolean): DomainRecord => ({
      id,
      domain: `${id}.test`,
      status: verified ? "verified" : "pending",
      provider: null,
      verified,
      notes: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    const allVerified = await runDiagnostics({
      _store: storeServingDomains([domain("a", true), domain("b", true)]),
    });
    expect(named(allVerified, "Domains").status).toBe("pass");
    expect(named(allVerified, "Domains").message).toContain("2/2 domains ownership-verified");
    // #110's finding, applied here: what a passing check did NOT weigh has to be named in
    // the passing case too, or "2/2 domains verified" reads as a DKIM all-clear.
    expect(named(allVerified, "Domains").message).toContain("NOT a DKIM verdict");

    const partial = await runDiagnostics({
      _store: storeServingDomains([domain("a", true), domain("b", false)]),
    });
    expect(named(partial, "Domains").status).toBe("warn");
    expect(named(partial, "Domains").message).toContain("1/2 domains ownership-verified");
    // The old check counted DKIM status. `DomainRecord` has no DKIM column, so the wording
    // must not claim a fact the seam does not carry.
    expect(named(partial, "Domains").message).toContain("DKIM is not weighed here");
  });

  it("warns when this machine holds no config file and passes when it does", async () => {
    const absent = await runDiagnostics({ _store: realStore() });
    const absentConfig = named(absent, "Config");
    expect(absentConfig.status).toBe("warn");
    expect(absentConfig.message).toContain("created automatically");
    expect(absentConfig.message).not.toContain("emails config set");

    const { setConfigValue } = await import("./config.js");
    setConfigValue("cloudflare_account_id", "acct");

    const present = await runDiagnostics({ _store: realStore() });
    expect(named(present, "Config").status).toBe("pass");
  });
});

describe("formatDiagnostics", () => {
  it("formats checks with pass/warn/fail icons", () => {
    const checks: DoctorCheck[] = [
      { name: "Store", status: "pass", message: "OK" },
      { name: "Config", status: "warn", message: "Missing" },
      { name: "Creds", status: "fail", message: "Invalid" },
    ];
    const out = formatDiagnostics(checks);
    expect(out).toContain("Store");
    expect(out).toContain("OK");
    expect(out).toContain("Config");
    expect(out).toContain("Missing");
    expect(out).toContain("Creds");
    expect(out).toContain("Invalid");
    expect(out).toContain("Summary");
    expect(out).toContain("1 passed");
    expect(out).toContain("1 warnings");
    expect(out).toContain("1 failed");
  });

  it("formats all-pass summary without warnings/failures", () => {
    const checks: DoctorCheck[] = [
      { name: "A", status: "pass", message: "Good" },
      { name: "B", status: "pass", message: "Great" },
    ];
    const out = formatDiagnostics(checks);
    expect(out).toContain("2 passed");
    expect(out).not.toContain("warnings");
    expect(out).not.toContain("failed");
    expect(out).not.toContain("unknown");
  });

  it("contains diagnostics header", () => {
    const out = formatDiagnostics([]);
    expect(out).toContain("Email System Diagnostics");
    expect(out).toContain("Summary");
  });

  it("counts unknown separately from warnings and failures, and renders it", () => {
    const out = formatDiagnostics([
      { name: "A", status: "pass", message: "Good" },
      { name: "B", status: "warn", message: "Known" },
      { name: "C", status: "unknown", message: "Could not look" },
    ]);

    expect(out).toContain("1 unknown");
    expect(out).toContain("1 warnings");
    expect(out).toContain("Could not look");
    // A status with no icon renders as `undefined`, which is how a widened union that the
    // formatter was never taught about would show up.
    expect(out).not.toContain("undefined");
    expect(out).not.toContain("2 warnings");
  });
});

// ─── PROVISIONING HONESTY ON AN API-BACKED INSTALLATION ──────────────────────────────
//
// Live repro (task 1c675265): `emails doctor --json` on a client whose store is the
// hosted API returned {name:"Provisioning: cloudflare",status:"fail"} because the
// cloudflare/resend rows keyed off LOCAL env/config unconditionally — the same
// fabricated negative the aws row was already spared ("unknown", above), one provider
// over. Provisioning on such an installation is executed by the service, whose
// credentials this client cannot observe.
describe("provisioning credentials on an API-backed installation", () => {
  function configureApiStorage(): void {
    delete process.env["EMAILS_DB_PATH"];
    process.env["EMAILS_SELF_HOSTED_URL"] = "https://mail.example.test";
    process.env["EMAILS_SELF_HOSTED_API_KEY"] = "test-key";
  }

  it("reports absent local cloudflare/resend credentials as unknown, never fail", async () => {
    configureApiStorage();

    const checks = await runDiagnostics({ _store: realStore() });

    const cloudflare = named(checks, "Provisioning: cloudflare");
    expect(cloudflare.status).toBe("unknown");
    expect(cloudflare.message).toContain("service");
    const resend = named(checks, "Provisioning: resend");
    expect(resend.status).toBe("unknown");
    expect(checks.some((check) => check.name.startsWith("Provisioning: ") && check.status === "fail")).toBe(false);
  });

  it("keeps the fail verdict for a local installation, where the credential really is the operator's to set", async () => {
    const checks = await runDiagnostics({ _store: realStore() });

    expect(named(checks, "Provisioning: cloudflare").status).toBe("fail");
    expect(named(checks, "Provisioning: cloudflare").message).toContain("CLOUDFLARE_API_TOKEN");
  });

  it("still reports a present local cloudflare credential as pass on an API-backed installation", async () => {
    // Positive control: the unknown path must not swallow an observable credential.
    configureApiStorage();
    process.env["CLOUDFLARE_API_TOKEN"] = "token";
    process.env["CLOUDFLARE_ACCOUNT_ID"] = "account";

    const checks = await runDiagnostics({ _store: realStore() });

    expect(named(checks, "Provisioning: cloudflare").status).toBe("pass");
  });
});
