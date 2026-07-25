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
    from: "andrei@hasna.com",
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
