// Inbound delivery diagnosis — ONE implementation, over the store seam.
//
// This family used to be three files: a facade that picked an implementation from the
// process-wide deployment read, a local arm that did the whole diagnosis against SQLite
// through five other families' `*.local.*` arms, and an HTTP arm that threw for both
// entrypoints and carried a BYTE-FOR-BYTE COPY of the report formatter. The two arms did
// not disagree about what "diagnose inbound delivery for this address" MEANS; they
// disagreed about who was running. That is the switch the mode-removal program deletes,
// so the arms are gone and this is the only implementation.
//
// WHERE THE FACTS COME FROM. Every stored fact is read through `EmailStore`
// (src/store/), resolved from storage configuration by `createConfiguredEmailStore()`
// (src/store-resolution.ts). There is deliberately NO second resolution path here: a
// diagnosis that read some facts from the configured store and others from a differently
// resolved source could describe two different installations in one report, which is
// worse than describing none.
//
// THREE FACTS THE SEAM CANNOT SERVE, and what this module does instead of guessing.
// They are reported here rather than fixed by widening `src/store/`, which is a shared
// contract two audits are waiting on:
//
//   1. Domain DNS and inbound-lifecycle status. `DomainRecord` has no DKIM/SPF/DMARC
//      status, no `inbound_status` and no `source_of_truth`, so `assessDomainReadiness()`
//      (src/lib/domain-readiness.ts) cannot be fed from the seam at all. Send readiness is
//      therefore reported as EXPLICITLY NOT CHECKED, with the command that does check it,
//      and never as passing. Receive readiness is answered from the provisioning status
//      and the ready-address count, which ARE on the seam — and its message names the
//      evidence it could not weigh, in the passing case as well as the failing one, so a
//      narrower claim cannot be read as a broader one. A delivery doctor that says "send
//      DNS is fine" because it could not look is the exact failure this program removes.
//   2. Address lookup by email. `AddressesRepository` offers `listAddresses(limit,
//      offset)` and no by-email operation, so the registry is paged and matched here —
//      the same composition `store-http` already documents for `getDomainByName`. A scan
//      that is refused or hits its page cap makes the answer UNKNOWN, and an unknown
//      answer is reported as a failure, never as "no address is configured". The
//      difference between those two is the whole point.
//   3. Address ownership history. `address_ownership_events` has no repository on the
//      seam, so the local arm's informational "Ownership audit" line has no source and
//      is dropped rather than fabricated. It only ever emitted `pass`, so its absence
//      asserts nothing; the current owner IS still checked, from `owner_id`.
//
// REFUSALS ARE REPORTED, NEVER ABSORBED. Every store call returns `Outcome<T>`; a
// refusal becomes a check that names its code and message. Nothing here turns a refusal
// into an empty list, a zero, or a missing line — `recent_local_messages` is
// `number | null` for exactly that reason, because a store that could not count is not a
// store that counted zero.

import { ALL_DOMAINS, CATCH_ALL } from "../db/aliases.js";
import type { EmailStore } from "../store/email-store.js";
import type { AddressRecord, MessageListRecord, ResourceRow } from "../store/records.js";
import type { Outcome } from "../store/outcome.js";
import { createConfiguredEmailStore } from "../store-resolution.js";
import { getInboundBuckets, loadConfig } from "./config.js";
import type { MxAssessment } from "./mx-ownership.js";

export interface DeliveryDoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  fix_command?: string;
}

export interface DeliveryDoctorReport {
  address: string;
  domain: string | null;
  alias_target: string | null;
  /**
   * Recent inbound messages addressed to this address, capped at
   * `RECENT_MAIL_REPORT_LIMIT` — or NULL when the store refused to answer.
   *
   * Null rather than 0, and the distinction is the reason the field is nullable: "no
   * mail has arrived for this address" and "this store would not tell me" are opposite
   * diagnoses, and a zero cannot tell them apart. The check list carries the refusal
   * that produced the null.
   */
  recent_local_messages: number | null;
  latest_received_at: string | null;
  /**
   * Which store answered, from `StoreDescriptor.detail` — safe to print by contract.
   * Recorded so a report can be attributed to an installation instead of being read as
   * a statement about whichever store the reader happens to be configured for.
   */
  store: string;
  checks: DeliveryDoctorCheck[];
  cli_equivalent: string;
}

export interface DeliveryDoctorOptions {
  /**
   * The store to diagnose. Defaults to the one this process's storage configuration
   * names. Injected by tests, and by a caller that already holds a store.
   */
  store?: EmailStore;
}

export interface LiveDeliveryDoctorOptions extends DeliveryDoctorOptions {
  inspectMx?: (domain: string) => Promise<MxAssessment>;
}

/** How many registry pages a lookup will scan before it calls the answer unknown. */
const ADDRESS_SCAN_PAGE_SIZE = 500;
const ADDRESS_SCAN_MAX_PAGES = 40;

/**
 * How many rows the recent-mail read asks for, and how many it reports.
 *
 * The seam's `to` filter is a SUBSTRING match on the recipient list (see
 * `messageFilters` in src/store-sqlite/messages.ts), so `ops@example.com` also selects
 * `devops@example.com`. The fetch is therefore wider than the report and the exact
 * recipient match is made here, mirroring how `inbound_recipients` is populated
 * (src/db/database.ts, `normalizedRecipientSql`).
 */
const RECENT_MAIL_SCAN_LIMIT = 500;
const RECENT_MAIL_MAX_PAGES = 5;
const RECENT_MAIL_REPORT_LIMIT = 10;

/** Provisioning states that mean a domain can receive. Mirrors domain-readiness.ts. */
const DOMAIN_RECEIVE_READY_STATES = new Set(["ready", "inbound_ready"]);

function check(
  status: DeliveryDoctorCheck["status"],
  name: string,
  message: string,
  fix_command?: string,
): DeliveryDoctorCheck {
  return { name, status, message, fix_command };
}

/**
 * A refusal rendered for a human, code first so the machine-readable part survives.
 *
 * Takes the whole outcome and narrows INSIDE, rather than being handed an already-narrowed
 * refusal: the seam's discriminant only narrows at a direct `outcome.ok` test, so a helper
 * that returned `Refusal | null` would force every caller to re-test `ok` anyway or reach
 * for a cast. Callers here check `ok` and call this on the refusing branch.
 */
function refusalText<T>(outcome: Outcome<T>): string {
  if (outcome.ok) throw new Error("refusalText was given a successful outcome");
  return `${outcome.code} (${outcome.status}): ${outcome.message}`;
}

/**
 * The address form `inbound_recipients` indexes: display-name wrappers unwrapped,
 * trimmed, lowercased. Kept here as a private helper rather than imported: the only
 * existing export of this operation is dispatched through the deployment switch this
 * module has just stopped depending on, and pulling that dispatcher back in for a pure
 * string function would undo the collapse.
 */
function normalizeRecipient(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  const bracketed = raw.match(/<\s*([^<>\s@]+@[^<>\s@]+)\s*>/);
  const email = bracketed?.[1] ?? raw;
  return /^[^\s@<>]+@[^\s@<>]+$/.test(email) ? email : null;
}

function stringField(row: ResourceRow, key: string): string | null {
  const value = row[key];
  if (typeof value === "string") return value.trim() === "" ? null : value;
  return null;
}

/** What one pass over the address registry learned. */
interface AddressScan {
  /** Addresses whose email is exactly the one asked about. */
  matches: AddressRecord[];
  /** Receive-ready address counts per domain name, for the domain readiness check. */
  readyByDomain: Map<string, number>;
  /**
   * Why the scan could not prove `matches` is complete, or null when it is complete.
   * A non-null reason forbids concluding "no such address".
   */
  inconclusive: string | null;
}

async function scanAddresses(store: EmailStore, email: string): Promise<AddressScan> {
  const matches: AddressRecord[] = [];
  const readyByDomain = new Map<string, number>();
  for (let page = 0; page < ADDRESS_SCAN_MAX_PAGES; page += 1) {
    const outcome = await store.addresses.listAddresses({
      limit: ADDRESS_SCAN_PAGE_SIZE,
      offset: page * ADDRESS_SCAN_PAGE_SIZE,
    });
    if (!outcome.ok) return { matches, readyByDomain, inconclusive: refusalText(outcome) };
    for (const address of outcome.value) {
      if (address.email.trim().toLowerCase() === email) matches.push(address);
      const domain = (address.domain ?? "").trim().toLowerCase();
      if (domain && address.provisioning_status === "ready") {
        readyByDomain.set(domain, (readyByDomain.get(domain) ?? 0) + 1);
      }
    }
    if (outcome.value.length < ADDRESS_SCAN_PAGE_SIZE) {
      return { matches, readyByDomain, inconclusive: null };
    }
  }
  return {
    matches,
    readyByDomain,
    inconclusive:
      `the address registry is larger than the ${ADDRESS_SCAN_MAX_PAGES * ADDRESS_SCAN_PAGE_SIZE} rows ` +
      "this lookup scans, so a matching address may exist beyond them",
  };
}

interface AliasLookup {
  target: string | null;
  refusal: string | null;
}

/**
 * Alias resolution, in the same three-step order the alias table has always been read:
 * the exact local part, then the domain's catch-all, then the global catch-all.
 */
async function resolveAliasTarget(store: EmailStore, email: string): Promise<AliasLookup> {
  const at = email.indexOf("@");
  if (at <= 0 || at === email.length - 1) return { target: null, refusal: null };
  const localPart = email.slice(0, at);
  const domain = email.slice(at + 1);
  for (const [aliasDomain, aliasLocalPart] of [
    [domain, localPart],
    [domain, CATCH_ALL],
    [ALL_DOMAINS, CATCH_ALL],
  ] as const) {
    const outcome = await store.aliases.list({
      limit: 1,
      filters: { domain: aliasDomain, local_part: aliasLocalPart },
    });
    if (!outcome.ok) return { target: null, refusal: refusalText(outcome) };
    const row = outcome.value[0];
    const target = row ? stringField(row, "target_address") : null;
    if (target) return { target, refusal: null };
  }
  return { target: null, refusal: null };
}

interface RecentMail {
  /** Null when the answer is unknown; never a zero standing in for "unknown". */
  count: number | null;
  latest_received_at: string | null;
  refusal: string | null;
  /** The scan stopped before the end of the matching rows, so `count` is a floor. */
  truncated: boolean;
}

function addressedTo(message: MessageListRecord, email: string): boolean {
  return message.to_addrs.some((recipient) => normalizeRecipient(recipient) === email);
}

/**
 * Recent inbound mail for this address, in ANY folder.
 *
 * DELIBERATE DIFFERENCE FROM THE LOCAL ARM, stated because it changes an answer: the
 * old query excluded archived mail (`is_archived = 0`) and included spam and trash. The
 * seam's folder vocabulary has no such combination, so this counts arrivals in every
 * folder. Archiving, spam-filing and trashing are things that happen AFTER delivery, and
 * a delivery doctor that answers "no mail found" because the mail was archived has
 * mis-diagnosed the one question it was asked.
 */
async function recentMail(store: EmailStore, email: string): Promise<RecentMail> {
  const matched: MessageListRecord[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; ; page += 1) {
    // THE BOUND IS WHY THIS PAGES AT ALL. The store's `to` filter is a substring match, so
    // a mailbox with many `devops@…` arrivals can fill page after page without holding one
    // message actually addressed to `ops@…`. Reading a single page and reporting zero would
    // turn that into "no mail has arrived", which is the false negative this whole module
    // is written against.
    if (page >= RECENT_MAIL_MAX_PAGES) {
      truncated = true;
      break;
    }
    const outcome = await store.messages.listMessages({
      direction: "inbound",
      to: email,
      limit: RECENT_MAIL_SCAN_LIMIT,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (!outcome.ok) {
      return { count: null, latest_received_at: null, refusal: refusalText(outcome), truncated: false };
    }
    for (const message of outcome.value.items) {
      if (addressedTo(message, email)) matched.push(message);
    }
    if (matched.length >= RECENT_MAIL_REPORT_LIMIT) break;
    const next = outcome.value.next_cursor;
    if (next === null) break;
    cursor = next;
  }
  if (truncated && matched.length === 0) {
    // Unknown, not zero. The scan ran out of budget without seeing the end of the rows, so
    // it cannot tell "nothing arrived" from "nothing in the rows I read".
    return {
      count: null,
      latest_received_at: null,
      refusal:
        `the inbound scan reached its ${RECENT_MAIL_MAX_PAGES * RECENT_MAIL_SCAN_LIMIT}-row bound ` +
        `without finding a message addressed to ${email}, so "none arrived" cannot be ` +
        "distinguished from \"none in the rows scanned\"",
      truncated: true,
    };
  }
  const reported = matched.slice(0, RECENT_MAIL_REPORT_LIMIT);
  const latest = reported
    .map((message: MessageListRecord) => message.received_at)
    .find((value: string | null) => value !== null) ?? null;
  return { count: reported.length, latest_received_at: latest, refusal: null, truncated };
}

/** The current owner's display name, or the reason it is not known. */
async function ownerLabelFor(store: EmailStore, ownerId: string): Promise<{ name: string | null; refusal: string | null }> {
  const outcome = await store.owners.get(ownerId);
  if (!outcome.ok) return { name: null, refusal: refusalText(outcome) };
  const row = outcome.value;
  return { name: row ? stringField(row, "name") : null, refusal: null };
}

async function appendAddressChecks(
  store: EmailStore,
  checks: DeliveryDoctorCheck[],
  address: string,
  scan: AddressScan,
): Promise<void> {
  for (const match of scan.matches) {
    const provisioning = match.provisioning_status ?? "unknown";
    checks.push(check("pass", "Configured address", `${match.email} is configured (address ${match.id.slice(0, 8)}, status ${match.status}).`));
    checks.push(provisioning === "ready"
      ? check("pass", "Address receive readiness", "Address provisioning is ready.")
      : check("warn", "Address receive readiness", `Address provisioning is ${provisioning}.`, `emails address provision ${address} --provider <provider> --wait`));
    if (match.owner_id) {
      const owner = await ownerLabelFor(store, match.owner_id);
      if (owner.refusal) {
        checks.push(check("fail", "Ownership", `Owner ${match.owner_id.slice(0, 8)} is recorded but the store refused to read it: ${owner.refusal}.`));
      } else if (owner.name) {
        checks.push(check("pass", "Ownership", `Owned by ${owner.name}.`));
      } else {
        checks.push(check("warn", "Ownership", `Owner ${match.owner_id.slice(0, 8)} is recorded but not registered.`, `emails address set-owner ${match.id} --owner <owner>`));
      }
    } else {
      checks.push(check("warn", "Ownership", "No owner/admin assigned.", `emails address set-owner ${match.id} --owner <owner>`));
    }
  }
}

/**
 * Diagnose why inbound mail may not be reaching an address.
 *
 * Async because every store operation is: the seam requires it so that no caller's
 * control flow depends on which of the two stores it holds.
 */
export async function diagnoseInboundDelivery(
  address: string,
  options: DeliveryDoctorOptions = {},
): Promise<DeliveryDoctorReport> {
  const store = options.store ?? createConfiguredEmailStore();
  const normalized = address.trim().toLowerCase();
  const hasLocalPartAndDomain = /^[^\s@]+@[^\s@]+$/.test(normalized);
  const domain = hasLocalPartAndDomain ? normalized.slice(normalized.indexOf("@") + 1) : null;
  const checks: DeliveryDoctorCheck[] = [];

  if (!hasLocalPartAndDomain) {
    checks.push(check("fail", "Address format", "Expected a full email address.", undefined));
  } else {
    checks.push(check("pass", "Address format", "Address parses as local-part@domain."));
  }

  const scan = hasLocalPartAndDomain
    ? await scanAddresses(store, normalized)
    : { matches: [], readyByDomain: new Map<string, number>(), inconclusive: null };
  const alias = hasLocalPartAndDomain
    ? await resolveAliasTarget(store, normalized)
    : { target: null, refusal: null };
  const recent = hasLocalPartAndDomain
    ? await recentMail(store, normalized)
    : {
        count: null,
        latest_received_at: null,
        refusal: "the address is not a full email address, so no recipient could be looked up",
        truncated: false,
      };

  // Reported whether or not a match was found, and that is the point: a scan that
  // stopped early can still have found one address while missing a second on another
  // provider, and its receive-ready counts — which the domain check below reads — are
  // then a floor rather than a total. Only saying so in the no-match branch would let an
  // incomplete scan pass for a complete one on every other line of the report.
  if (scan.inconclusive) {
    checks.push(check(
      "fail",
      "Address registry",
      `The address registry could not be read completely: ${scan.inconclusive}. ` +
        "Address and domain readiness below may be incomplete.",
      "emails address list",
    ));
  }

  if (scan.matches.length > 0) {
    await appendAddressChecks(store, checks, normalized, scan);
  } else if (alias.target) {
    checks.push(check("pass", "Alias", `${normalized} resolves to ${alias.target}.`));
  } else if (scan.inconclusive) {
    // NOT "no address is configured". The scan did not finish, so the honest answer is
    // that the question is unanswered — reported as a failure so it cannot be read as a
    // clean bill of health for a mailbox that may well exist.
    checks.push(check("fail", "Configured address", `Could not determine whether ${normalized} is configured: ${scan.inconclusive}.`, `emails address list`));
  } else if (hasLocalPartAndDomain) {
    checks.push(check("warn", "Configured address", "No exact address or alias configured in this installation's store.", `emails address provision ${normalized} --provider <provider>`));
  }

  // Also unconditional. `alias_target` is reported even when an exact address exists, so
  // a refused alias read would otherwise leave a null in the report with nothing saying
  // the lookup never happened.
  if (alias.refusal) {
    checks.push(check("fail", "Alias", `Alias resolution was refused by the store: ${alias.refusal}.`, `emails alias list`));
  }

  if (domain) {
    const domainOutcome = await store.domains.getDomainByName(domain);
    if (!domainOutcome.ok) {
      checks.push(check("fail", "Domain", `Could not determine whether ${domain} is configured: ${refusalText(domainOutcome)}.`, `emails domain list`));
    } else if (domainOutcome.value) {
      const record = domainOutcome.value;
      const readyAddresses = scan.readyByDomain.get(record.domain.trim().toLowerCase()) ?? 0;
      const provisioning = record.provisioning_status ?? "unknown";
      const receiveReady = DOMAIN_RECEIVE_READY_STATES.has(provisioning) || readyAddresses > 0;
      const lastError = record.last_error ? ` Last provisioning error: ${record.last_error}.` : "";
      // THE CAVEAT IS PART OF THE ANSWER, and it is why it is in the pass message too.
      // `assessDomainReadiness()` also weighs the inbound lifecycle status and whether a
      // live inbound source exists; neither is on the seam, so a bare `pass` here would
      // be a narrower claim than it reads as. Saying which evidence was NOT weighed is
      // what keeps it from being a clean bill of health for something unexamined.
      const unweighed =
        " Inbound lifecycle status and live inbound-source evidence were not weighed: the store does not carry them.";
      checks.push(receiveReady
        ? check("pass", "Domain receive readiness", `${record.domain} is receive-ready (provisioning ${provisioning}, ${readyAddresses} ready address(es)).${lastError}${unweighed}`)
        : check("warn", "Domain receive readiness", `${record.domain} is not receive-ready (provisioning ${provisioning}, ${readyAddresses} ready address(es)).${lastError}${unweighed}`, `emails domain check ${record.domain}`));
      // NOT CHECKED, and said so. The store carries no DKIM/SPF/DMARC status, so there
      // is no evidence here either way — and "warn, go and verify" is the only answer
      // that does not invent one.
      checks.push(check(
        "warn",
        "Domain send readiness",
        `Send DNS was not checked: the store does not carry ${record.domain}'s DKIM/SPF/DMARC status. ` +
          `Ownership is ${record.verified ? "verified" : "not verified"}.`,
        `emails domain verify ${record.domain}`,
      ));
    } else {
      checks.push(check("warn", "Domain", `${domain} is not configured in this installation's store.`, `emails domain adopt ${domain} --provider <provider>`));
    }
  }

  // The next two checks read THIS PROCESS'S operator configuration, not the store. They
  // are scoped that way in the message on purpose: an installation whose mail is kept
  // behind an API legitimately has no ingestion configured on the client, and a check
  // that said "no inbound sources" without saying whose would be read as a statement
  // about the server.
  const inboundBuckets = getInboundBuckets();
  if (inboundBuckets.length > 0) {
    checks.push(check("pass", "Inbound sources", `${inboundBuckets.length} S3 bucket(s) configured in this installation's config.`));
  } else {
    checks.push(check("fail", "Inbound sources", "No S3 inbound bucket is configured in this installation's config.", "emails inbox sync-status"));
  }

  const config = loadConfig();
  if (typeof config["inbound_realtime_queue_url"] === "string") {
    checks.push(check("pass", "Realtime", "Realtime queue is configured."));
  } else {
    checks.push(check("warn", "Realtime", "Realtime queue is not configured; manual refresh/sync is required.", domain ? `emails inbox setup-realtime ${domain}` : undefined));
  }

  if (recent.count === null) {
    checks.push(check("fail", "Recent local mail", `Recent mail could not be counted: ${recent.refusal ?? "the store gave no answer"}.`, `emails inbox list`));
  } else if (recent.count > 0) {
    const floor = recent.truncated ? "at least " : "";
    checks.push(check("pass", "Recent local mail", `${floor}${recent.count} message(s) found for ${normalized} in this installation's store.`));
  } else {
    checks.push(check("warn", "Recent local mail", "No messages found for this address in this installation's store.", `emails inbox wait ${normalized} --timeout 120`));
  }

  return {
    address: normalized,
    domain,
    alias_target: alias.target,
    recent_local_messages: recent.count,
    latest_received_at: recent.latest_received_at,
    store: store.descriptor.detail,
    checks,
    cli_equivalent: `emails doctor delivery ${normalized} --json`,
  };
}

export async function diagnoseInboundDeliveryLive(
  address: string,
  options: LiveDeliveryDoctorOptions = {},
): Promise<DeliveryDoctorReport> {
  const report = await diagnoseInboundDelivery(address, options);
  if (!report.domain) return report;

  const {
    formatMxRecords,
    inspectPublicMx,
    ownerLabel,
    requiresMxSwitchConfirmation,
  } = await import("./mx-ownership.js");
  const mx = await (options.inspectMx ?? inspectPublicMx)(report.domain);
  const owner = ownerLabel(mx.owner);
  const records = formatMxRecords(mx.records);

  if (mx.owner === "aws-ses") {
    report.checks.push(check("pass", "Public MX", `Root MX is owned by ${owner}: ${records}.`));
  } else if (mx.owner === "none") {
    report.checks.push(check("warn", "Public MX", "No public root MX records found.", `emails domain check ${report.domain}`));
  } else if (requiresMxSwitchConfirmation(mx)) {
    report.checks.push(check(
      "warn",
      "Public MX",
      `Root MX is owned by ${owner}: ${records}. Do not add SES inbound MX unless you intend to move inbound mail.`,
      `emails forwarding explain ${report.address}`,
    ));
  } else {
    report.checks.push(check("warn", "Public MX", `${mx.summary}.`, `emails domain check ${report.domain}`));
  }

  return report;
}

export function formatDeliveryDoctorReport(report: DeliveryDoctorReport): string {
  const lines = [`Delivery diagnosis: ${report.address}`];
  lines.push(`  Store:    ${report.store}`);
  lines.push(`  Domain:   ${report.domain ?? "(none)"}`);
  lines.push(`  Alias:    ${report.alias_target ?? "(none)"}`);
  // "(not counted)" rather than 0: the store refused, and printing a zero here would be
  // the same lie the nullable field exists to prevent.
  const recent = report.recent_local_messages === null ? "(not counted)" : String(report.recent_local_messages);
  lines.push(`  Recent:   ${recent}${report.latest_received_at ? `, latest ${report.latest_received_at}` : ""}`);
  lines.push("");
  for (const c of report.checks) {
    const mark = c.status === "pass" ? "ok" : c.status === "warn" ? "warn" : "fail";
    lines.push(`  [${mark}] ${c.name}: ${c.message}`);
    if (c.fix_command) lines.push(`        fix: ${c.fix_command}`);
  }
  return lines.join("\n");
}
