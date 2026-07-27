// `emails log --json` serialization contract.
//
// During the 2026-07-25 incident, operators scripted against `to` / `cc` and
// read null — the summary only carried `to_addresses` — and the output had NO
// status at all, so a ledger row stuck in `uncertain` rendered identically to
// a delivered message. The summary now carries `to`, `cc`, `cc_addresses`,
// `status`, and `send_state`, and the table shows the status column.

import { describe, expect, it } from "bun:test";
import type { TuiMessage } from "../../lib/mail-types.js";
import { formatSelfHostedDetail, formatSelfHostedSummaries, toSelfHostedSummary } from "./email-log.remote.js";

function sentMessage(over: Partial<TuiMessage> = {}): TuiMessage {
  return {
    kind: "sent",
    id: "0198c9a2-0000-7000-8000-000000000001",
    from: "andrei@example.com",
    to: "accountant@client.example, second@client.example",
    cc: "copy@client.example",
    subject: "monthly documents",
    date: "2026-07-25T09:04:00.000Z",
    is_read: true,
    is_starred: false,
    labels: [],
    snippet: "hello",
    thread_id: null,
    provider_thread_id: null,
    attachments: 0,
    sentByMe: true,
    status: "uncertain",
    send_state: "uncertain",
    ...over,
  };
}

describe("emails log --json summary", () => {
  it("serializes to, cc, cc_addresses, status, and send_state (not just to_addresses)", () => {
    const summary = toSelfHostedSummary(sentMessage());
    expect(summary.to).toEqual(["accountant@client.example", "second@client.example"]);
    expect(summary.cc).toEqual(["copy@client.example"]);
    expect(summary.to_addresses).toEqual(["accountant@client.example", "second@client.example"]);
    expect(summary.cc_addresses).toEqual(["copy@client.example"]);
    expect(summary.status).toBe("uncertain");
    expect(summary.send_state).toBe("uncertain");
  });

  it("keeps cc empty and status null when the backend does not report them", () => {
    const summary = toSelfHostedSummary(sentMessage({ cc: undefined, status: undefined, send_state: undefined }));
    expect(summary.cc).toEqual([]);
    expect(summary.cc_addresses).toEqual([]);
    expect(summary.status).toBeNull();
    expect(summary.send_state).toBeNull();
  });

  it("shows the send status in the single-message view (`emails show`) too", () => {
    const detail = {
      ...toSelfHostedSummary(sentMessage()),
      text_body: "hello",
      html_body: null,
      flags: [],
    };
    const rendered = formatSelfHostedDetail(detail);
    expect(rendered).toContain("Status:");
    expect(rendered).toContain("uncertain");
    // A delivered inbound message without ledger state shows no status line.
    const plain = formatSelfHostedDetail({
      ...toSelfHostedSummary(sentMessage({ status: undefined, send_state: undefined })),
      text_body: null,
      html_body: null,
      flags: [],
    });
    expect(plain).not.toContain("Status:");
  });

  it("shows the send status in the table so an uncertain send can never render as delivered", () => {
    const uncertain = toSelfHostedSummary(sentMessage());
    const sent = toSelfHostedSummary(sentMessage({ id: "0198c9a2-0000-7000-8000-000000000002", status: "sent", send_state: "sent" }));
    const table = formatSelfHostedSummaries([uncertain, sent], "Self-hosted sent mail");
    expect(table).toContain("Status");
    expect(table).toContain("uncertain");
    expect(table).toContain("sent");
  });
});

// A BLOCKED send must state WHY (2026-07-27).
//
// On 2026-07-22 an outbound email carrying the customs documents for a held
// shipment was refused by the outbound policy gate with `sender_unverified`. The
// reason was written to headers.policy_denial on the message row, and every CLI
// path — `emails show`, `emails log`, `emails email list` — serialized a fixed
// shape that dropped `headers`. So the row read as the bare word `blocked`, the
// failure sat unnoticed for five days, and the shipment was returned to its
// shipper. Recovering the cause required calling GET /v1/messages/{id} by hand.
//
// These tests pin the reason to the payload AND to both renderers: a summary field
// alone would still let the human output print an unexplained `blocked`.
describe("a blocked send states its reason (policy_denial)", () => {
  function blockedMessage(over: Partial<TuiMessage> = {}): TuiMessage {
    return sentMessage({
      id: "0198c9a2-0000-7000-8000-00000000b10c",
      subject: "Re: AWB customs documents",
      status: "blocked",
      send_state: "blocked",
      policy_denial: "sender_unverified",
      ...over,
    });
  }

  it("carries policy_denial in the --json summary", () => {
    expect(toSelfHostedSummary(blockedMessage()).policy_denial).toBe("sender_unverified");
  });

  it("is null — not undefined — when the row was not policy-refused", () => {
    const summary = toSelfHostedSummary(sentMessage());
    expect(summary.policy_denial).toBeNull();
    // JSON.stringify drops undefined, which would make the field vanish from
    // `emails log --json` for exactly the rows a script iterates over.
    expect(JSON.parse(JSON.stringify(summary))).toHaveProperty("policy_denial", null);
  });

  it("names the reason in the single-message view (`emails show`)", () => {
    const rendered = formatSelfHostedDetail({
      ...toSelfHostedSummary(blockedMessage()),
      text_body: "documents attached",
      html_body: null,
      flags: [],
    });
    expect(rendered).toContain("blocked");
    expect(rendered).toContain("sender_unverified");
    // And it must say the send never reached a provider, so nobody goes hunting
    // through SES logs for a message that was stopped locally.
    expect(rendered).toContain("outbound policy gate");
  });

  it("names the reason in the table (`emails log` / `emails email list`)", () => {
    const table = formatSelfHostedSummaries([toSelfHostedSummary(blockedMessage())], "Self-hosted sent mail");
    expect(table).toContain("blocked (sender_unverified)");
  });

  it("does not truncate the reason out of the status column", () => {
    // The column was a fixed 10 characters, which would render
    // `blocked (sender_unverified)` as `blocked (s` — losing the reason a second
    // time, in the renderer instead of the serializer.
    const table = formatSelfHostedSummaries(
      [toSelfHostedSummary(blockedMessage({ policy_denial: "address_quota_exceeded" }))],
      "Self-hosted sent mail",
    );
    expect(table).toContain("blocked (address_quota_exceeded)");
  });

  it("falls back to the bare state rather than inventing a reason", () => {
    const noReason = toSelfHostedSummary(blockedMessage({ policy_denial: undefined }));
    expect(noReason.policy_denial).toBeNull();
    const table = formatSelfHostedSummaries([noReason], "Self-hosted sent mail");
    expect(table).toContain("blocked");
    expect(table).not.toContain("blocked (");
    const detail = formatSelfHostedDetail({ ...noReason, text_body: null, html_body: null, flags: [] });
    expect(detail).toContain("blocked");
    expect(detail).not.toContain("Blocked by:");
  });

  it("never appends a reason to a delivered send", () => {
    // Defensive: a stale denial code left on a row that later succeeded must not
    // make a delivered message look refused.
    const delivered = toSelfHostedSummary(
      blockedMessage({ status: "sent", send_state: "sent", policy_denial: "sender_unverified" }),
    );
    const table = formatSelfHostedSummaries([delivered], "Self-hosted sent mail");
    expect(table).not.toContain("sent (sender_unverified)");
  });
});
