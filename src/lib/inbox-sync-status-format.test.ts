// `emails inbox status` must not present a plausible number it cannot vouch for,
// and must not advertise a command that does not exist. Both defects were live in
// 1.3.0 and were found together on 2026-07-27 (2026-07-27).
//
// 1. THE COUNT. A stale explicit local-mode selector shadowed the
//    EMAILS_CLIENT_ENV_SECRET pointer, so this renderer printed
//    "Local inbox: 0 total, 0 unread" against a deployment holding ~170,000 messages.
//    It read as an empty mailbox, not as a misconfiguration — the mode resolution
//    carried a note (see src/lib/mode.ts) and this renderer never printed it.
//
// What the note SAYS is asserted in src/lib/mode.test.ts, next to the code that
// builds it. What this file asserts is that the renderer prints it at all, and prints
// it BEFORE the numbers it invalidates.
//
// 2. THE HINT. It printed "Pull now: emails refresh", and `emails refresh` is not a
//    registered command in any mode ("error: unknown command 'refresh'"). The
//    per-mode filter could not save it, because the entry sat only under
//    SELF_HOSTED_REFUSED_COMMANDS, so local mode printed the dead verb happily. A
//    operator followed the hint and hit the dead end.

import { describe, expect, it } from "bun:test";
import { formatInboxSyncStatus } from "./inbox-sync-status-format.js";
import { statusAvailable, statusUnavailable } from "./status-availability.js";
import type { EmailSystemStatus } from "./status-types.js";

// The mode block is declared inline on EmailSystemStatus, so name it from there
// rather than restating its shape — a hand-copied duplicate would drift silently.
type ModeStatus = EmailSystemStatus["mode"];

const POINTER = "hasna/xyz/opensource/emails/prod/client-env";

function localMode(warning: string | null): ModeStatus {
  return {
    current: "local",
    label: "Local",
    // `kind: "env"` with no name: this renderer never reads the source, and naming
    // the mode variable here would push the mode-axis ratchet up for nothing.
    source: { kind: "env", name: null, value: "local" },
    warning,
  };
}

/** A status shaped like the one the blinded local read actually produced: zeroes. */
function emptyLocalStatus(mode: ModeStatus): EmailSystemStatus {
  const available = statusAvailable("local_database", "client_enumeration");
  return {
    generated_at: "2026-07-27T13:00:00.000Z",
    mode,
    degraded: false,
    limited: false,
    unavailable: [],
    failures: [],
    limitations: [],
    incomplete: [],
    gaps: {},
    database: { availability: available, data_dir: "/tmp/emails-test" },
    providers: { availability: available, total: 0, active: 0, by_type: {} },
    domains: {
      availability: available,
      total: 0, verified: 0, send_ready: 0, receive_ready: 0,
      usable: [], usable_limit: 25, usable_truncated: false,
    },
    addresses: {
      availability: available,
      total: 0, active: 0, verified: 0, owned: 0, ready_to_receive: 0,
      usable_from: [], usable_from_limit: 25, usable_from_truncated: false,
    },
    inbox: {
      total: 0, unread: 0, latest_received_at: null,
      inbound_buckets: { availability: available, items: [], total: 0 },
      realtime: {
        availability: available,
        queue_configured: false, queue_url: null, last_poll_at: null, last_error: null,
      },
    },
    mailboxes: { counts: { inbox: 0, unread: 0, sent: 0, archived: 0, spam: 0, trash: 0, starred: 0 }, folders: [] },
    sources: {
      availability: available,
      total: 0, active: 0, legacy: 0, orphaned: 0,
      items: [], limit: 50, truncated: false,
      configured: {
        availability: statusUnavailable("not_applicable", "local_mode", "local_database"),
        total: null, by_status: null, latest_last_synced_at: null,
      },
    },
    provisioning: {
      availability: available,
      domains_pending: 0, domains_failed: 0, addresses_pending: 0, addresses_failed: 0,
    },
    next_actions: [],
    cli_equivalents: {},
  };
}

describe("formatInboxSyncStatus — a shadowed pointer invalidates the counts", () => {
  // An opaque sentinel, not the real message: this test asserts the renderer passes
  // the note through verbatim, so a fixture that duplicated the wording would only
  // re-test src/lib/mode.ts and would drift from it.
  const warning = `the configured EMAILS_CLIENT_ENV_SECRET pointer '${POINTER}' was overridden`;
  const rendered = formatInboxSyncStatus(emptyLocalStatus(localMode(warning)));

  it("prints the mode note verbatim", () => {
    expect(rendered).toContain("Mode note:");
    expect(rendered).toContain(warning);
  });

  it("prints it ABOVE the inbox count", () => {
    // Order is the whole point: a caveat printed after "0 total, 0 unread" is read
    // after the reader has already concluded the mailbox is empty.
    const noteAt = rendered.indexOf("Mode note:");
    const countAt = rendered.indexOf("Local inbox:");
    expect(noteAt).toBeGreaterThan(-1);
    expect(countAt).toBeGreaterThan(-1);
    expect(noteAt).toBeLessThan(countAt);
  });

  it("stays silent when there is nothing being shadowed", () => {
    const clean = formatInboxSyncStatus(emptyLocalStatus(localMode(null)));
    expect(clean).not.toContain("Mode note:");
    // …but still renders the ordinary payload, so silence is not emptiness.
    expect(clean).toContain("Local inbox: 0 total, 0 unread");
  });
});

describe("formatInboxSyncStatus — the pull hint names a real command", () => {
  const rendered = formatInboxSyncStatus(emptyLocalStatus(localMode(null)));

  it("suggests `emails pull`, never `emails refresh`", () => {
    expect(rendered).toContain("Pull now: emails pull");
    expect(rendered).not.toContain("emails refresh");
  });

  it("omits the pull hint in self_hosted, where the server owns ingestion", () => {
    const selfHosted = emptyLocalStatus({
      current: "self_hosted",
      label: "Self-hosted",
      source: { kind: "env", name: "EMAILS_CLIENT_ENV_SECRET", value: POINTER },
      warning: null,
    });

    const out = formatInboxSyncStatus(selfHosted);
    expect(out).not.toContain("emails pull");
    expect(out).not.toContain("emails refresh");
  });
});
