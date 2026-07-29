// ONE set of system diagnostics. There is no arm to pick, and nothing here asks where
// this installation keeps its mail.
//
// WHAT THIS FILE USED TO BE, because the shape is the bug: `doctor.ts` was a 23-line
// facade that read the process-wide deployment word (src/lib/mode.ts) and handed
// `runDiagnostics` to one of two modules. `doctor.local.ts` (158 lines) opened the local
// SQLite database and counted providers, domains, addresses, contacts and templates with
// hand-written `SELECT COUNT(*)`; `doctor.remote.ts` (133 lines) never opened a database
// and probed the operator service's `/health` and `/ready` instead. Same name, same
// signature, two different reports — and an environment variable decided which one an
// operator (or an agent, through MCP) was shown. That is the deployment-mode axis, and
// both arms are gone.
//
// WHAT REPLACES THE ARM CHOICE: the store seam (`src/store/`). Every resource fact below
// is read through the one `EmailStore` this installation's storage configuration names,
// so "how many providers are configured?" is answered by the STORE rather than by a mode
// word — the local SQLite store answers it from its tables, an API store answers it from
// `/v1`, and a store that cannot answer REFUSES with a typed refusal that this file
// reports as such.
//
// ─── THE RULE THIS FILE IS WRITTEN AROUND ────────────────────────────────────────────
//
// A DIAGNOSTIC THAT CANNOT CHECK SOMETHING MUST REFUSE, NOT REPORT HEALTH. This repo has
// already shipped the inverse twice, and both are recorded in CHANGELOG.md: one command
// answered "Nothing is missing" while the sibling command it recommended one line later
// said "No records to check", and this very family reported `Self-hosted API: pass`
// because a client configuration PARSED, without ever making a request. So:
//
//   * a store refusal is reported as a refusal, naming the code and the status;
//   * a fact the seam does not project is reported as `unknown`, naming WHY;
//   * a count is assembled by an enumeration that stops only on an EMPTY page — a SHORT
//     page is not end-of-table, and a count that did not reach the end is a LOWER BOUND;
//   * no check is ever silently omitted, because an absent check reads as "nothing wrong".
//
// `DoctorCheck.status` was widened from `pass | warn | fail` to include `unknown` for
// exactly this reason (src/lib/diagnostics-format.ts). A three-value status cannot express
// "I could not look", and every value it CAN express is a claim about the system.
//
// ─── WHAT THIS FILE DELIBERATELY DOES NOT DO ─────────────────────────────────────────
//
//  1. It never asks WHICH store it holds. `src/store-resolution.ts` is explicit that
//     construction is the only place that answer is visible, and that its plan union is
//     not a runtime label for callers to branch on. `store.descriptor` is read here to
//     PRINT the store's identity — which is the use src/store/descriptor.ts declares it
//     for, "logs and `doctor` output" — and there is no comparison, no `switch` and no
//     narrowing on it anywhere in this file.
//  2. It does not validate provider sending credentials. It cannot: the seam REDACTS
//     credential columns from the generic resource read by contract (see
//     `REDACTED_COLUMNS` in src/store-sqlite/resources.ts, and the API's resource routes
//     are summary-only for the same reason). Reporting "credentials invalid" from rows
//     that never carry credentials would be a fabricated negative, so the check says it
//     is not observable here and names the command that owns the question.
//  3. It does not touch the deployment-mode axis module, the dispatch layer, the curl
//     bridge, or any mode-gated branch in another family. Those are phase 9's, and only
//     once the ratchet in src/mode-axis-ratchet.test.ts reads zero.
//
// The local machine facts — the config file, the AWS sandbox probe, the provisioning
// credential scan — are NOT store questions and stay where they were. They are facts
// about this box, and they are the same facts whichever store the box is configured with.

import { existsSync } from "fs";
import { join } from "path";
import { createConfiguredEmailStore, StoreConfigurationError } from "../store-resolution.js";
import { unavailableCapabilities } from "../store/capabilities.js";
import type { EmailStore } from "../store/email-store.js";
import type { Outcome, Refusal } from "../store/outcome.js";
import type { AddressRecord, DomainRecord, ResourceRow } from "../store/records.js";
import type { Database } from "../db/database.js";
import { getEmailsDataDir, loadConfig } from "./config.js";
import type { DoctorCheck } from "./diagnostics-format.js";

export { formatDiagnostics } from "./diagnostics-format.js";
export type { DoctorCheck } from "./diagnostics-format.js";

export interface DiagnosticsOptions {
  /**
   * Retained because four call sites pass it (the CLI, the MCP `run_doctor` tool, the
   * dashboard route and the SDK re-export). It no longer triggers a live provider
   * credential probe, and it is NOT ignored: it changes what the provider-credential
   * check REPORTS, so a caller who asked for a live check is told the request could not
   * be honoured here rather than being shown a check that quietly did less than it says.
   */
  liveProviderChecks?: boolean;
  /**
   * @internal for testing — inject a store instead of building the configured one.
   *
   * A test seam, not a routing seam: there is exactly one production path, and it is
   * `createConfiguredEmailStore()`. Handing in a store lets a test exercise a refusal, a
   * truncated page or a fault without an operator configuration behind it.
   */
  _store?: EmailStore;
}

/**
 * Rows requested per page.
 *
 * THE SEAM HAS NO COUNT OPERATION for these families — `ListOptions` is `{ limit, offset }`
 * and nothing returns a total — so a count has to be assembled by enumerating, and the
 * deleted local arm's `SELECT COUNT(*)` has no equivalent here. 500 is what the SQLite store
 * and the service both cap a list at (`MAX_PAGE` in src/store-sqlite/resources.ts;
 * src/server/self-hosted/store.ts:829-830), so it is the most that can come back per request.
 * It is a REQUEST, not an assumption: see `enumerate` for why nothing here relies on getting
 * 500 back.
 */
const PAGE_SIZE = 500;

/**
 * How many pages a count may cost before the answer becomes "at least N".
 *
 * A diagnostic must not walk a million-row contacts table. Four pages bounds the work at
 * ~2,000 rows and five requests per family, and past that the honest report is a floor.
 */
const MAX_PAGES = 4;

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDatabase(value: unknown): value is Database {
  return typeof value === "object" && value !== null && "query" in value;
}

/**
 * Report a store refusal.
 *
 * A refusal is split two ways on purpose. `capability_unavailable` means the store
 * DECLARED it cannot do this (src/store/capabilities.ts) — a known property of the
 * installation, not a fault, and the honest report is "could not look". Every other
 * refusal code (a scope violation, an invalid input, a conflict) means the question was
 * asked wrongly or the answer was withheld, and a diagnostic must show that as a failure.
 * Neither is ever reported as a zero or an empty list.
 */
function refusalCheck(subject: string, refusal: Refusal): DoctorCheck {
  return {
    name: subject,
    status: refusal.code === "capability_unavailable" ? "unknown" : "fail",
    message:
      `${subject} could not be read through the store (${refusal.code}, HTTP ${refusal.status}): ` +
      refusal.message,
  };
}

/**
 * Schema readiness — the deleted remote arm's `/ready` probe, accounted for rather than
 * dropped in silence.
 *
 * That arm probed the operator service's `GET /ready` and reported `pendingMigrations`. The
 * seam has no readiness operation, and the only way to reach `/ready` from here would be
 * the axis module the store seam exists to remove — which in a local SQLite configuration
 * would report a `fail` for a service that configuration does not have. So the signal is
 * genuinely gone, and this check exists so that its absence is VISIBLE in the report
 * instead of being inferred from a shorter list of checks.
 *
 * Deliberately configuration-neutral: it is the same unknown for both stores, which is the
 * point of removing the axis. It does not name a URL, because nothing here may ask whether
 * this installation has one.
 */
function readinessCheck(): DoctorCheck {
  return {
    name: "Store readiness",
    status: "unknown",
    message:
      "Whether this store's schema is fully migrated is not observable: the store seam exposes no " +
      "readiness operation, and a served read only proves the store answers. An Emails service " +
      "answers this on its own /ready endpoint; a local database applies its migrations when it is " +
      "opened.",
  };
}

/** A subject whose only source is a store that could not be built. Never a zero. */
function unobservableWithoutStore(subject: string, failure: string): DoctorCheck {
  return {
    name: subject,
    status: "unknown",
    message: `${subject} is not observable: no store could be constructed for this installation (${failure})`,
  };
}

/**
 * What a read of the store turned out to be.
 *
 * Kept separate from the check it produces because the `Store` reachability verdict needs
 * it and cannot recover it from a status: a REFUSAL is not evidence the store was reached.
 * The HTTP store decides a capability refusal locally, without sending a request, so
 * treating "it refused" as "it answered" would be a `pass` for a store nothing ever
 * talked to — the fabricated green light this family already shipped once.
 */
type ReadKind = "answered" | "refused" | "faulted";

/** What a bounded enumeration saw. */
interface Enumerated<TRow> {
  rows: TRow[];
  /**
   * True only when an EMPTY page ended the scan. That is the sole proof of end-of-table
   * available through this seam, and therefore the sole condition under which a count
   * derived from these rows is a total rather than a floor.
   */
  complete: boolean;
}

/**
 * Count a family by enumerating it, within a budget.
 *
 * TWO RULES, and each of them is a bug this file would otherwise have:
 *
 * 1. **A SHORT PAGE IS NOT END-OF-TABLE.** A store is free to serve fewer rows than were
 *    asked for — a lower internal clamp, a proxy, a future implementation — and stopping on
 *    a short page would publish that clamp as a complete total. `100 contacts` for a table
 *    holding 40,000 is worse than saying nothing. Only an empty page ends the scan.
 * 2. **THE OFFSET ADVANCES BY ROWS RECEIVED, NOT ROWS REQUESTED.** Advancing by
 *    `PAGE_SIZE` after a store served 100 would skip rows 100-499 and then call the
 *    undercount exact — the same fabrication wearing a loop.
 *
 * When the budget runs out without an empty page the rows gathered are a floor, `complete`
 * is false, and the caller reports `unknown`. A refusal or a fault at any page propagates:
 * a partial enumeration is never reported as a count.
 *
 * The count is assembled from successive pages, so it is a snapshot rather than a
 * transactional total; these families are not gated on `keysetPagination`, so concurrent
 * writes during the scan can perturb it. For a diagnostic that is the right trade against
 * having no count at all — and it is stated rather than implied.
 */
async function enumerate<TRow>(
  read: (limit: number, offset: number) => Promise<Outcome<TRow[]>>,
): Promise<Outcome<Enumerated<TRow>>> {
  const rows: TRow[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const outcome = await read(PAGE_SIZE, rows.length);
    if (!outcome.ok) return outcome;
    if (outcome.value.length === 0) return { ok: true, value: { rows, complete: true } };
    rows.push(...outcome.value);
  }
  return { ok: true, value: { rows, complete: false } };
}

/**
 * Read one resource family and describe what came back.
 *
 * `describe` is only ever called with rows the store actually served, and its second
 * argument says whether those rows are the WHOLE answer or a bounded prefix. A thrown
 * error is a fault (a dead connection, a malformed row) and is reported as a failure —
 * distinct from a refusal, which is a normal answer.
 */
async function resourceCheck<TRow>(
  subject: string,
  read: (limit: number, offset: number) => Promise<Outcome<TRow[]>>,
  describe: (rows: TRow[], truncated: boolean) => Omit<DoctorCheck, "name">,
): Promise<{ check: DoctorCheck; kind: ReadKind }> {
  let outcome: Outcome<Enumerated<TRow>>;
  try {
    outcome = await enumerate(read);
  } catch (error) {
    return {
      kind: "faulted",
      check: {
        name: subject,
        status: "fail",
        message: `${subject} could not be read through the store: ${detailOf(error)}`,
      },
    };
  }
  if (!outcome.ok) return { kind: "refused", check: refusalCheck(subject, outcome) };
  const { rows, complete } = outcome.value;
  return {
    kind: "answered",
    check: { name: subject, ...describe(rows, !complete) },
  };
}

/**
 * The `unknown` an unfinished enumeration forces.
 *
 * Called instead of `describeExact` whenever the scan ran out of budget without reaching an
 * empty page, because at that point every number derivable from those rows — the total AND
 * any sub-count over them — is a floor. Printing the observed count there, or printing
 * "2000/2000 verified", would be a fabricated total dressed as a measurement.
 */
function boundedCount(
  observed: number,
  noun: string,
  truncated: boolean,
  describeExact: (total: number) => Omit<DoctorCheck, "name">,
): Omit<DoctorCheck, "name"> {
  if (!truncated) return describeExact(observed);
  return {
    status: "unknown",
    message:
      `at least ${observed} ${noun} — the store seam exposes no count operation for this family, and ` +
      `enumerating it did not reach the end within ${MAX_PAGES} pages, so neither the total nor any ` +
      "proportion over it is observable here",
  };
}

/**
 * A stored flag column, read without guessing.
 *
 * SQLite holds these as `0`/`1` and the API answers them as JSON booleans. A column that is
 * PRESENT AND NULL is the "not set" the deleted arm's `SUM(CASE WHEN suppressed = 1 …)` also
 * counted as false, so that stays false — the semantics are preserved, not invented.
 *
 * A column that is ABSENT FROM THE ROW ENTIRELY is a different thing and returns `null`.
 * Adversarial review of this collapse caught them being conflated: a store whose rows simply
 * do not carry the column would have had every row read as `false` and reported
 * "N contacts (0 suppressed)" — a fabricated zero about suppression, which is the one number
 * in this report that decides whether someone gets mailed who asked not to be.
 *
 * Anything else — a string, an object, a number that is not 0 or 1 — is also `null` rather
 * than coerced, and the caller reports the derived count as unknown.
 */
function flagColumn(row: ResourceRow, column: string): boolean | null {
  if (!Object.prototype.hasOwnProperty.call(row, column)) return null;
  const value = row[column];
  if (typeof value === "boolean") return value;
  if (value === 1) return true;
  if (value === 0) return false;
  if (value === null || value === undefined) return false;
  return null;
}

/** How many rows carry the flag, or `null` when any row's value could not be read. */
function countFlagged(rows: ResourceRow[], column: string): number | null {
  let flagged = 0;
  for (const row of rows) {
    const value = flagColumn(row, column);
    if (value === null) return null;
    if (value) flagged += 1;
  }
  return flagged;
}

/**
 * Whether this machine holds the local config file.
 *
 * `getEmailsDataDir()` rather than `getDataDir()` from the database layer: they resolve
 * the same directory, but the database one CREATES and hardens it as a side effect
 * (src/lib/config.ts:7-21 says so explicitly), which is right before a database open and
 * wrong for a diagnostic that may not be configured with a database at all.
 */
function configCheck(): DoctorCheck {
  const configPath = join(getEmailsDataDir(), "config.json");
  return existsSync(configPath)
    ? { name: "Config", status: "pass", message: `Config file exists (${configPath})` }
    // Names no "emails config set": that command does not exist (task 0d03f185). The
    // file appears when a command first stores a setting; its absence needs no action.
    : { name: "Config", status: "warn", message: `No config file (${configPath}) — created automatically the first time a command stores a setting, e.g. \`emails aws setup-inbound\`.` };
}

/**
 * What this installation's store declares it cannot do.
 *
 * Not a fault and not a health verdict — a `warn` that names the declared limits, so an
 * operator reading `doctor` output learns why an operation later refuses instead of
 * discovering it mid-send. `pass` only when the store declares every capability true.
 */
function capabilitiesCheck(store: EmailStore): DoctorCheck {
  const unavailable = unavailableCapabilities(store.capabilities);
  if (unavailable.length === 0) {
    return { name: "Store capabilities", status: "pass", message: "This store declares every capability available." };
  }
  return {
    name: "Store capabilities",
    status: "warn",
    message:
      `This store declares ${unavailable.length} capabilit${unavailable.length === 1 ? "y" : "ies"} unavailable: ` +
      `${unavailable.join(", ")}. Declared, not broken — every operation that needs one refuses with a ` +
      "typed refusal rather than answering with an empty result.",
  };
}

/**
 * Provider sending credentials — the one check whose data the seam deliberately withholds.
 *
 * Stated plainly because it is a REDUCTION in what `emails doctor` does: the deleted local
 * arm called `checkAllProviders()` and, with `--live`, made a real API call per provider.
 * That is not reproducible here. The provider rows the seam serves have their credential
 * columns redacted in BOTH stores by design, so this file can neither validate a key nor
 * honestly report one missing — and calling the local provider repository directly instead
 * would read local SQLite rows under a configuration that names an API, which is the exact
 * fabrication the deleted remote arm existed to avoid.
 *
 * So the check is `unknown` and names `emails provider status`, which is one command, in
 * one file, in both configurations (src/cli/commands/provider.ts — no arm, no mode gate,
 * and absent from `SELF_HOSTED_REFUSED_COMMANDS` in src/lib/status-commands.ts), and which
 * DOES perform the live validation. Recommending a command that refuses would be the same
 * defect class as reporting a count nobody measured.
 */
function providerCredentialsCheck(liveRequested: boolean): DoctorCheck {
  return {
    name: "Provider credentials",
    status: "unknown",
    message:
      (liveRequested
        ? "A live provider credential check was requested and cannot be performed by these diagnostics. "
        : "Not checked here. ") +
      "The store seam redacts provider sending credentials from the generic resource read in both " +
      "stores, so this diagnostic can neither validate a key nor report one as missing without " +
      "fabricating the answer. Run 'emails provider status' — it validates credentials against each " +
      "provider's API and works in every configuration.",
  };
}

/**
 * SES sandbox / production access.
 *
 * Gated on AWS credentials being present in the environment, because that is what the
 * probe needs and their absence is an observable fact rather than a guess. The failure
 * path is the change worth noting: the deleted arm swallowed it (`catch {}`) and emitted
 * NO check, so "we could not ask AWS" looked identical to "AWS is fine" — an absent check
 * reads as nothing wrong. It is an explicit `unknown` now.
 */
async function sesSandboxChecks(): Promise<DoctorCheck[]> {
  if (!process.env["AWS_ACCESS_KEY_ID"] && !process.env["AWS_PROFILE"]) return [];
  try {
    const { getSandboxStatus, describeSandboxStatus } = await import("./ses-sandbox.js");
    const status = await getSandboxStatus({ region: process.env["AWS_REGION"] ?? "us-east-1" });
    return [{
      name: "SES Sending",
      status: status.sendingEnabled ? "pass" : "fail",
      message: describeSandboxStatus(status),
    }];
  } catch (error) {
    return [{
      name: "SES Sending",
      status: "unknown",
      message:
        "AWS credentials are present in the environment but the SES account-status probe could not be " +
        `performed: ${detailOf(error)}`,
    }];
  }
}

/**
 * Provisioning credentials for AWS, Cloudflare and Resend.
 *
 * `aws_provider_credentials` is passed as `"unknown"`, and that is not a shortcut. The
 * fact it stands for — "this installation has SES keys stored on a provider row" — lives
 * in exactly the columns the seam redacts, so it is not observable here in EITHER
 * configuration. Passing `false` would have printed "Set AWS_PROFILE or
 * AWS_ACCESS_KEY_ID/SECRET" with status `fail` at an operator whose stored SES keys are
 * fine, which is a fabricated negative. `ProvisionCredConfig` was widened to carry the
 * third value rather than have this file invent one of the two it had.
 */
async function provisioningChecks(): Promise<DoctorCheck[]> {
  const { checkProvisionCredentials } = await import("./provision-creds.js");
  // `loadConfig()` READS AND PARSES a file on disk and throws on a malformed one. Left
  // unguarded that took the WHOLE report down — one corrupt config file and an operator
  // running `emails doctor` to find out what is wrong gets a stack trace instead of a
  // diagnosis, including for the checks that had already succeeded. The failure is reported
  // as the check it belongs to.
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (error) {
    return [{
      name: "Provisioning: config",
      status: "fail",
      message:
        "The provisioning credential checks could not run because this machine's config file " +
        `could not be read: ${detailOf(error)}`,
    }];
  }
  // Whether this installation's storage resolves to the API decides whether an absent
  // LOCAL provisioning credential is a fault (local installation: yes, it is the
  // operator's to set) or unobservable (API-backed: the service provisions with its own
  // credentials — task 1c675265). A storage configuration that cannot be planned is
  // already reported by the Store check; local semantics are kept for that case.
  let serviceOwnedProvisioning = false;
  try {
    const { planEmailStore } = await import("../store-resolution.js");
    serviceOwnedProvisioning = planEmailStore(process.env).store === "api";
  } catch {
    // Reported by the Store check; the credential rows keep local semantics.
  }
  return checkProvisionCredentials(undefined, {
    aws_provider_credentials: "unknown",
    service_owned_provisioning: serviceOwnedProvisioning,
    cloudflare_api_token: config["cloudflare_api_token"] as string | undefined,
    cloudflare_api_key: config["cloudflare_api_key"] as string | undefined,
    cloudflare_email: config["cloudflare_email"] as string | undefined,
    cloudflare_account_id: config["cloudflare_account_id"] as string | undefined,
  }).map((credential) => ({
    name: `Provisioning: ${credential.provider}`,
    status: credential.status ?? (credential.configured ? "pass" : credential.provider === "resend" ? "warn" : "fail"),
    message: credential.detail,
  }));
}

/**
 * Reachability, derived from EVERY read this report made rather than from one of them.
 *
 * Adversarial review of this collapse caught the single-probe version: reachability was
 * inferred from the providers read alone, so one malformed provider row reported
 * `Store: fail` for a store that was answering everything else perfectly — a FALSE FAILURE,
 * which sends an operator to debug their transport instead of their data. Aggregating fixes
 * that without ever going the other way:
 *
 *   * ANY read answered  -> `pass`. One served read is proof the store was reached.
 *   * none answered, some faulted -> `fail`. Every attempt errored; that is a real fault.
 *   * every read refused -> `unknown`. A refusal is NOT reachability evidence: the HTTP
 *     store decides a capability refusal locally, without sending a request, so a `pass`
 *     here would be the same fabrication as the `Self-hosted API: pass` this family shipped
 *     for a client configuration that merely parsed.
 */
function reachabilityCheck(store: EmailStore, kinds: ReadKind[]): DoctorCheck {
  // `descriptor` is PRINTED, never compared. src/store/descriptor.ts declares it for exactly
  // this use and types `kind` as `string` so that no branch on it can narrow.
  const identity = `the ${store.descriptor.kind} store (${store.descriptor.detail})`;
  if (kinds.includes("answered")) {
    return { name: "Store", status: "pass", message: `A read was served by ${identity}.` };
  }
  if (kinds.includes("faulted")) {
    return {
      name: "Store",
      status: "fail",
      message: `Every read against ${identity} failed. See the checks below for the errors.`,
    };
  }
  return {
    name: "Store",
    status: "unknown",
    message:
      `${identity} refused every read this report attempted, which says nothing about whether it can ` +
      "be reached. See the checks below for the refusals.",
  };
}

/** Every store-backed check, in a fixed order, from one store. */
async function storeChecks(store: EmailStore): Promise<DoctorCheck[]> {
  const providers = await resourceCheck<ResourceRow>(
    "Providers",
    (limit, offset) => store.providers.list({ limit, offset }),
    (rows, truncated) => boundedCount(rows.length, "provider(s) configured", truncated, (total) =>
      total > 0
        ? { status: "pass", message: `${total} provider(s) configured` }
        : { status: "warn", message: "No providers configured" }),
  );

  const domains = await resourceCheck<DomainRecord>(
    "Domains",
    (limit, offset) => store.domains.listDomains({ limit, offset }),
    (rows, truncated) => boundedCount(rows.length, "domain(s)", truncated, (total) => {
      if (total === 0) return { status: "warn", message: "No domains configured" };
      const verified = rows.filter((row) => row.verified).length;
      // NAMED PRECISELY, because it is not the fact the deleted arm reported. That one
      // counted `dkim_status = 'verified'`; `DomainRecord` carries no DKIM column at all
      // (src/store/records.ts), and its `verified` maps to `domains.verified_at IS NOT
      // NULL` (src/store-sqlite/registry.ts:12). Reusing the old wording over the new
      // column would have quietly relabelled one fact as another — and the PASSING case is
      // where that matters most, because "2/2 domains verified" reads as "nothing to do
      // about DNS" to an operator whose DKIM records were never published. So the fact this
      // check measures is named in the count itself, and what it did NOT weigh is stated in
      // every outcome, pass included.
      return {
        status: verified === total ? "pass" : "warn",
        message:
          `${verified}/${total} domains ownership-verified — NOT a DKIM verdict: the store seam ` +
          "projects no DKIM status, so DKIM is not weighed here even when this check passes",
      };
    }),
  );

  const addresses = await resourceCheck<AddressRecord>(
    "Addresses",
    (limit, offset) => store.addresses.listAddresses({ limit, offset }),
    (rows, truncated) => boundedCount(rows.length, "sender address(es)", truncated, (total) => ({
      status: total > 0 ? "pass" : "warn",
      message: `${total} sender address(es)`,
    })),
  );

  const contacts = await resourceCheck<ResourceRow>(
    "Contacts",
    (limit, offset) => store.contacts.list({ limit, offset }),
    (rows, truncated) => boundedCount(rows.length, "contacts", truncated, (total) => {
      const suppressed = countFlagged(rows, "suppressed");
      if (suppressed === null) {
        return {
          status: "unknown",
          message:
            `${total} contacts; how many are suppressed is not observable — a stored 'suppressed' value ` +
            "was neither a boolean nor 0/1, and guessing what it meant would be worse than saying so",
        };
      }
      return {
        status: suppressed > 0 ? "warn" : "pass",
        message: `${total} contacts (${suppressed} suppressed)`,
      };
    }),
  );

  const templates = await resourceCheck<ResourceRow>(
    "Templates",
    (limit, offset) => store.templates.list({ limit, offset }),
    (rows, truncated) => boundedCount(rows.length, "template(s)", truncated, (total) => ({
      status: "pass",
      message: `${total} template(s)`,
    })),
  );

  const reads = [providers, domains, addresses, contacts, templates];
  return [
    reachabilityCheck(store, reads.map((read) => read.kind)),
    readinessCheck(),
    capabilitiesCheck(store),
    ...reads.map((read) => read.check),
  ];
}

/**
 * The subjects a store would have answered, when no store could be built.
 *
 * Emitted rather than omitted, and `unknown` rather than zero. The check LIST stays the
 * same length and the same names in both cases, so a consumer diffing two runs sees
 * "could not look" where it would otherwise see a number — instead of a shorter report
 * that reads as a clean bill of health.
 */
function storelessChecks(failure: string): DoctorCheck[] {
  return [
    "Store capabilities",
    "Providers",
    "Domains",
    "Addresses",
    "Contacts",
    "Templates",
  ].map((subject) => unobservableWithoutStore(subject, failure));
}

/**
 * Run every diagnostic.
 *
 * The first parameter is retained for arity compatibility with the deleted facade, whose
 * consumers call `runDiagnostics(undefined, opts)`. A caller that actually supplies a
 * `Database` is REFUSED rather than having its handle silently dropped: these checks read
 * through the store seam, so a supplied connection would be reported on by nothing while
 * the caller believed it was the subject of the report.
 */
export async function runDiagnostics(
  dbOrOptions?: Database | DiagnosticsOptions,
  options: DiagnosticsOptions = {},
): Promise<DoctorCheck[]> {
  if (isDatabase(dbOrOptions)) {
    throw new Error(
      "runDiagnostics no longer accepts a database handle: these diagnostics read every resource " +
        "fact through the store seam (src/store/), so a caller-supplied SQLite connection would be " +
        "silently ignored while the report claimed to describe it. Pass options only — and use the " +
        "internal `_store` option to point the checks at a specific store.",
    );
  }
  const opts = dbOrOptions ?? options;

  // Built here rather than at module load: a contradictory storage configuration is a boot
  // error from the resolution, and a doctor is the one tool an operator runs precisely
  // BECAUSE the configuration is broken. So the error is reported as a failing check
  // instead of thrown — the report is the product here — and every subject that needed the
  // store is reported as unobservable rather than as zero.
  let store: EmailStore;
  try {
    store = opts._store ?? createConfiguredEmailStore();
  } catch (error) {
    const settings = error instanceof StoreConfigurationError ? ` Settings at fault: ${error.settings.join(", ")}.` : "";
    const failure = detailOf(error);
    return [
      {
        name: "Store",
        status: "fail",
        message: `No store could be constructed from this installation's storage configuration. ${failure}${settings}`,
      },
      readinessCheck(),
      ...storelessChecks(failure),
      configCheck(),
      providerCredentialsCheck(opts.liveProviderChecks === true),
      ...(await sesSandboxChecks()),
      ...(await provisioningChecks()),
    ];
  }

  const checks = await storeChecks(store);
  checks.push(configCheck());
  checks.push(providerCredentialsCheck(opts.liveProviderChecks === true));
  checks.push(...(await sesSandboxChecks()));
  checks.push(...(await provisioningChecks()));
  return checks;
}
