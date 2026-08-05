// ONE batch sender. There is no arm to pick, and nothing here asks where this
// installation keeps its mail.
//
// WHAT THIS FILE USED TO BE, because the shape is the bug: `batch.ts` was a facade
// that read the process-wide deployment mode and handed the call to one of two
// modules. `batch.local.ts` rendered a template per CSV row, checked suppression,
// sent through the provider adapters and wrote the sent-mail ledger; `batch.remote.ts`
// threw. Same name, same signature, opposite meanings — the operation either happened
// or did not exist, decided by an environment variable. That is the deployment-mode
// axis, and both arms are gone.
//
// WHAT REPLACES THE ARM CHOICE. The template this batch renders is read through the
// store seam (`src/store/`), so the answer to "can this installation serve a batch
// send?" comes from the STORE'S OWN ANSWER rather than from a mode word:
//
//   * the local SQLite store filters templates by name and serves the row;
//   * a store that cannot answer "the template named X" REFUSES, with a typed refusal
//     carrying a code and a message, and this function throws that refusal loudly.
//
// A refusal is never reported as `{ sent: 0, failed: 0, errors: [] }`. Zero sends with
// no errors is the answer for an empty CSV, and a store that could not be asked must
// not be indistinguishable from one that had nothing to do.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO — asked, because getting it wrong would
// rebuild the axis under a new name:
//
//   1. It never asks WHICH store it holds. `src/store-resolution.ts` is explicit that
//      construction is the only place that answer is visible and that its plan union is
//      not a runtime label for callers to branch on. A branch here on the store kind, or
//      on the descriptor, would be the same switch with a nicer spelling.
//   2. It does not route the SEND through the seam. `SendIntentsRepository` is gated on
//      the idempotency-fenced ledger and BOTH stores declare that capability false today
//      (src/store-sqlite/index.ts, src/store-http/index.ts), so sending through it would
//      refuse in every configuration and break batch sending outright. One send service
//      is phase 8 of docs/PLAN-MODE-REMOVAL.md; until it lands, the send and the
//      sent-mail ledger stay with the modules that own them.
//   3. It does not reimplement suppression, the send counters, or the template
//      substitution syntax. Their canonical-address handling and their placeholder
//      grammar live in the contacts and templates families, each a phase-4 migration of
//      its own; a second copy here would be a second source of truth for who may be
//      mailed and for what `{{name}}` means.
//
// For (2) and (3) this module imports the FACADE of each family, never an arm. Reaching
// into a `.local` module — which is what the deleted `batch.local.ts` did for four
// different families — is how a call ends up serving local rows under a configuration
// that names something else.
//
// STATED PLAINLY so no reviewer has to infer it: those facades still dispatch on the
// axis internally, so this module's dependency on it is TRANSITIVE, not gone. What is
// gone is batch's OWN mode decision — the one that made `batchSend` mean two different
// things. The transitive part goes when each of those families is collapsed in turn, and
// the axis itself is deleted in phase 9 and in no earlier phase.

import { readFileSync } from "fs";
import { getSuppressedEmailSet, incrementSendCounts } from "../db/contacts.js";
import { renderTemplate } from "../db/templates.js";
import { createConfiguredEmailStore } from "../store-resolution.js";
import type { EmailStore } from "../store/email-store.js";
import type { ResourceRow } from "../store/records.js";
import type { Provider } from "../types/index.js";
import { parseCsv } from "./csv.js";
import { canonicalSender } from "./email-address.js";
import { assertDomainOutboundReady, sendWithFailover } from "./send.js";
import { createSentEmailLedger } from "./sent-ledger.local.js";

export { parseCsv } from "./csv.js";

export interface BatchResult {
  total: number;
  sent: number;
  failed: number;
  suppressed: number;
  errors: { email: string; error: string }[];
}

export interface BatchSendOptions {
  csvPath: string;
  templateName: string;
  from: string;
  provider: Provider;
  force?: boolean;
  /** @internal for testing — inject an adapter instead of resolving from provider */
  _adapter?: { sendEmail: (opts: unknown) => Promise<string | undefined> };
  /** @internal for testing — inject CSV content instead of reading from file */
  _csvContent?: string;
  /**
   * @internal for testing — inject a store instead of building the configured one.
   *
   * A test seam, not a routing seam: there is exactly one production path, and it is
   * `createConfiguredEmailStore()`. Handing in a store lets a test exercise a refusal
   * without an operator configuration behind it.
   */
  _store?: EmailStore;
}

/** The template columns a batch render needs, after narrowing the stored row. */
interface BatchTemplate {
  subject_template: string;
  html_template: string | null;
  text_template: string | null;
}

/**
 * Read one text column out of a stored row.
 *
 * A non-string value is a FAULT and not a refusal: the row exists, the store answered,
 * and what came back is not a template. Throwing beats coercing it with `String(...)`,
 * which would mail whatever `[object Object]` renders to.
 */
function templateText(row: ResourceRow, column: string, name: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(`Template ${name} has a non-text ${column} (${typeof value}) and cannot be rendered`);
  }
  return value;
}

/**
 * The template named `name`, through the seam.
 *
 * The `name` equality filter is the question actually being asked, and asking it that
 * way is what makes a store that cannot answer refuse: the API store checks the
 * service's published contract and refuses a filter the list route does not accept,
 * rather than answering with the unfiltered list. So this either gets the right row or
 * gets a refusal — never a plausible wrong template.
 *
 * The re-check of `name` on the returned rows is a SECOND line of defence, not a
 * substitute for that: if some future store ever answered a filtered read with a
 * superset, the worst outcome here is "not found", never "rendered someone else's
 * template". Two rows for a unique name is an ambiguity this function refuses to
 * resolve by picking one.
 */
async function readBatchTemplate(store: EmailStore, name: string): Promise<BatchTemplate> {
  const found = await store.templates.list({ filters: { name }, limit: 2 });
  if (!found.ok) {
    throw new Error(
      `This installation's store cannot look up the template named ${name} ` +
        `(${found.code}, ${found.status}): ${found.message}`,
    );
  }
  const matching = found.value.filter((candidate) => candidate["name"] === name);
  const [row, extra] = matching;
  if (row === undefined) {
    throw new Error(`Template not found: ${name}`);
  }
  if (extra !== undefined) {
    throw new Error(`Template name ${name} matched ${matching.length} stored templates; refusing to guess which one`);
  }
  const subject = templateText(row, "subject_template", name);
  if (subject === null) {
    throw new Error(`Template ${name} has no subject_template and cannot be rendered`);
  }
  return {
    subject_template: subject,
    html_template: templateText(row, "html_template", name),
    text_template: templateText(row, "text_template", name),
  };
}

export async function batchSend(opts: BatchSendOptions): Promise<BatchResult> {
  // Built here rather than at module load: a contradictory storage configuration is a
  // boot error from the resolution, and it belongs to the call that needed a store —
  // not to whoever happened to import this module first.
  const store = opts._store ?? createConfiguredEmailStore();
  const csvContent = opts._csvContent ?? readFileSync(opts.csvPath, "utf-8");
  const rows = parseCsv(csvContent);

  const template = await readBatchTemplate(store, opts.templateName);

  const adapter = opts._adapter;
  const result: BatchResult = { total: rows.length, sent: 0, failed: 0, suppressed: 0, errors: [] };
  // The batch's own resolved store, so a `_store` injection scopes the suppression
  // read and the counter writes to the same rows it sends from.
  const suppressedEmailSet = opts.force
    ? new Set<string>()
    : await getSuppressedEmailSet(rows.map((row) => row["email"] ?? ""), store);
  const sentEmails: string[] = [];

  for (const row of rows) {
    const email = row["email"];
    if (!email) {
      result.failed++;
      result.errors.push({ email: "(missing)", error: "Row missing 'email' column" });
      continue;
    }

    // Check suppression — CANONICALLY, matching how the set was built and how the CLI
    // send path compares recipients. The set holds the STORED spelling and the
    // canonical (lowercased addr-spec) form of every suppressed contact; testing the
    // raw CSV string against it mailed `Blocked@Ext.com` — and counted it sent —
    // against a suppressed `blocked@ext.com`. Suppression means "never mail this
    // person", not "never mail this exact byte string". The fallback mirrors the
    // contacts module's own canonicalisation for non-addr-spec values.
    const canonicalEmail = canonicalSender(email) ?? email.trim().toLowerCase();
    if (!opts.force && suppressedEmailSet.has(canonicalEmail)) {
      result.suppressed++;
      continue;
    }

    try {
      const vars = row as Record<string, string>;
      const subject = renderTemplate(template.subject_template, vars);
      const html = template.html_template ? renderTemplate(template.html_template, vars) : undefined;
      const text = template.text_template ? renderTemplate(template.text_template, vars) : undefined;

      const sendOpts = {
        from: opts.from,
        to: email,
        subject,
        html,
        text,
      };
      assertDomainOutboundReady(opts.provider, sendOpts);

      const sent = adapter
        ? { providerId: opts.provider.id, messageId: await adapter.sendEmail(sendOpts) }
        : await sendWithFailover(opts.provider.id, sendOpts);
      await createSentEmailLedger(sent.providerId, sendOpts, sent.messageId);
      sentEmails.push(email);

      result.sent++;
    } catch (err) {
      result.failed++;
      result.errors.push({ email, error: err instanceof Error ? err.message : String(err) });
    }
  }

  await incrementSendCounts(sentEmails, store);

  return result;
}
