// WHERE THIS INSTALLATION KEEPS ITS MAIL, as far as its STORAGE CONFIGURATION says — and
// nothing else. One definition site, because there are now two callers and a second copy of
// this reasoning is how a sanctioned narrow answer becomes an unsanctioned general one.
//
// THIS IS NOT THE DEPLOYMENT-MODE AXIS WEARING A NEW NAME, and the difference is exact,
// because getting it wrong would rebuild the switch the mode-removal programme is deleting:
//
//   * it reads STORAGE SETTINGS only, through `planEmailStore` — the resolver that owns the
//     question. It never reads the deployment word, and it cannot: the resolver does not
//     look at it.
//   * it answers "WHICH STORE DID YOU CONFIGURE?", not "what kind of deployment is this?".
//   * a contradictory configuration is a REFUSAL (`unresolved`, carrying the resolver's own
//     message and the settings it named) rather than a silently-picked winner.
//   * it is NOT `StoreDescriptor`, which is two human strings that must never be branched on
//     (src/store/descriptor.ts), and it is NOT a capability. Whether an OPERATION is possible
//     is a capability question and is answered by `StoreCapabilities`.
//
// WHAT IT IS LEGITIMATELY FOR, stated as a rule rather than as a list, so a third caller can
// be judged against it: facts about work that THIS INSTALLATION PERFORMS ITSELF when it owns
// its database, and that the SERVICE performs instead when the mail is reached through an
// Emails API. For those, and only for those, "the store answered nothing" and "there is
// nobody on this side to ask" are different answers, and a zero, an empty list or a negative
// flag would be a fabricated claim rather than a measurement.
//
//   * `src/lib/status-facts.ts` — the local data directory, the inbound S3 bucket list and
//     the realtime ingestion queue. INGESTION into a local database is performed by this
//     installation and recorded in its own config file; ingestion into an Emails API is
//     performed by the service, which publishes no inventory of it.
//   * `src/lib/forwarding.ts` — app-level forwarding. It reads inbound bodies, sends copies
//     through this installation's provider adapters, and writes a sent-mail ledger and a
//     `forwarding_deliveries` ledger that exist in local SQLite and nowhere else. On an
//     API-configured installation forwarding belongs to the service, and "0 attempted"
//     there would be a fabricated claim about mail this side never looked at.
//
// WHAT IT IS NOT FOR: choosing between two implementations of the same operation. An
// operation that both stores can perform goes through the seam and takes the store's own
// answer; an operation neither can perform is an absence and says so
// (`src/db/email-content.ts`); an operation one store cannot perform is a CAPABILITY, and if
// the capability does not exist yet then the seam needs widening and the widening is the
// deliverable — not a branch here.

import { getDatabasePath } from "../db/database.js";
import { StoreConfigurationError, planEmailStore } from "../store-resolution.js";

/**
 * Where this installation keeps its mail, as far as its STORAGE configuration says.
 *
 * A closed union rather than a boolean, because "there is no local database file" has three
 * genuinely different causes and a caller has to tell them apart: the mail lives in an API,
 * the database is in memory, or the configuration does not resolve to a store at all.
 */
export type StorageWiring =
  | { kind: "database_file"; path: string }
  | { kind: "database_in_memory" }
  | { kind: "api" }
  | { kind: "unresolved"; message: string };

/**
 * An error's message, with the SETTINGS a store-configuration failure named appended.
 *
 * `StoreConfigurationError` carries the settings it refused on, and dropping them turns
 * "these two settings contradict each other" into an unactionable sentence.
 */
export function storeErrorMessage(error: unknown): string {
  const settings = error instanceof StoreConfigurationError ? ` (${error.settings.join(", ")})` : "";
  return `${error instanceof Error ? error.message : String(error)}${settings}`;
}

/**
 * Read the storage configuration ONCE.
 *
 * EVERY FAILURE MODE IS CAUGHT AND RETURNED, never thrown. Both `planEmailStore` (which
 * refuses a contradictory configuration) and `getDatabasePath` (which resolves, creates and
 * hardens a data directory, and refuses untrusted ancestors) can throw, and the callers need
 * the reason as data: `emails status` is the command an operator runs to find out what is
 * wrong and must never itself fail while reporting where its own files are, and the
 * forwarding pipeline has to name the contradiction in its refusal rather than surface a
 * bare path error.
 *
 * TWO DIFFERENT FAULTS ARRIVE AS `unresolved`, and a caller that phrases its own message must not
 * conflate them: a CONFIGURATION that names two stores at once, and a configuration that is the
 * unambiguous default whose DATA DIRECTORY is refused (an untrusted ancestor, a symlink). The
 * `message` says which; "your settings contradict each other" is a misdiagnosis of the second.
 *
 * `env` SELECTS THE STORE BUT NOT THE PATH, which is an inconsistency carried over verbatim from
 * the module this was extracted out of and is pinned by a test rather than fixed here.
 * `planEmailStore(env)` honours the argument; `getDatabasePath()` reads `process.env` directly and
 * takes no argument, so a path named ONLY in `env` decides THAT there is a local database and is
 * then ignored when reporting WHICH one. Harmless today because both shipped callers pass
 * `process.env` — closing it means giving the database layer an environment parameter, which is a
 * change to a file with unrelated work in flight, so it is reported rather than made.
 */
export function readStorageWiring(env: NodeJS.ProcessEnv): StorageWiring {
  try {
    const plan = planEmailStore(env);
    if (plan.store === "api") return { kind: "api" };
    // `plan.databasePath` is what the operator WROTE. The path reported here has to be the
    // one the rows are actually in, and the database layer canonicalises the value when it
    // opens the file, so the resolved path is read from there rather than from the plan.
    const path = getDatabasePath();
    return path === ":memory:" ? { kind: "database_in_memory" } : { kind: "database_file", path };
  } catch (error) {
    return { kind: "unresolved", message: storeErrorMessage(error) };
  }
}
