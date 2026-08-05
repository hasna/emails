// A REFUSED SEND MUST BE ABLE TO SAY WHY, ON EVERY SURFACE.
//
// evaluateOutboundPolicy refuses a send before any provider is contacted, and
// markSendBlocked records the code in headers.policy_denial. That is the whole
// explanation of a `send_state = 'blocked'` row — and it used to be unreachable:
//
//   * list rows: MESSAGE_LIST_COLUMNS omits `headers` on purpose (headers and bodies
//     were ~73% of a 459KB page), and publicMessageListItem stripped it again, so the
//     API could not carry the reason even in principle;
//   * the client: `emails show`, `emails log` and `emails email list` serialize a
//     fixed shape that dropped `headers`.
//
// So the only way to learn why a send was refused was to call GET /v1/messages/{id}
// by hand and read a jsonb column. On 2026-07-22 that hid a refused outbound email
// carrying customs documents for a held shipment: it read as the bare word `blocked`
// for five days, and the shipment was returned to its shipper.
//
// The fix is one short scalar, not the headers object: re-adding full headers to list
// rows would undo the payload decision that removed them. These tests pin the scalar
// in all three places it has to exist — the SQL projection, the published schema and
// the generated SDK type — because the failure mode is silence, and silence is what a
// missing field produces.
//
// Source-scanning precedent in this repo: src/lib/status-fabrication-scan.test.ts,
// src/server/self-hosted/list-order.test.ts, src/no-cloud-boundary.test.ts.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { policyDenialOf } from "./store.js";
import { emailsSelfHostedOpenApi } from "./openapi.js";

const HERE = import.meta.dir;

function readSource(...parts: string[]): string {
  return readFileSync(join(HERE, ...parts), "utf8");
}

describe("policyDenialOf — one emptiness rule for every projection", () => {
  it("keeps a real code", () => {
    expect(policyDenialOf("sender_unverified")).toBe("sender_unverified");
  });

  it("trims, because a padded code must not compare unequal to itself", () => {
    expect(policyDenialOf("  address_quota_exceeded \n")).toBe("address_quota_exceeded");
  });

  it("normalizes every absence to null, never to undefined or an empty string", () => {
    // undefined would be dropped by JSON.stringify, making a REQUIRED response
    // property vanish for exactly the rows a consumer iterates over; "" would render
    // as `blocked ()`.
    for (const absent of [undefined, null, "", "   ", 0, false, {}, []]) {
      expect(policyDenialOf(absent)).toBeNull();
    }
  });
});

describe("the list projection carries the reason", () => {
  const storeSource = readSource("store.ts");

  it("selects the denial code as its own column", () => {
    // Matches `m.headers->>'policy_denial' AS policy_denial` with any spacing.
    expect(storeSource).toMatch(/headers\s*->>\s*'policy_denial'\s+AS\s+policy_denial/);
  });

  it("still does NOT select the headers object onto list rows", () => {
    // The whole point of a scalar: the payload decision that removed headers and
    // bodies from list pages must survive this change. `m.body_text` may still be
    // READ inside the snippet expression (COALESCE(m.body_text, '') -> AS snippet) —
    // that derives 140 characters, it does not ship the body — so the assertion is
    // about what is SELECTED, not what is mentioned.
    const columns = storeSource.slice(storeSource.indexOf("const MESSAGE_LIST_COLUMNS"));
    const decl = columns.slice(0, columns.indexOf("\n\n"));
    // Every appearance of the headers column must be the ->> extraction.
    const headerRefs = decl.match(/\bm\.headers\b\s*(->>)?/g) ?? [];
    expect(headerRefs.length).toBeGreaterThan(0);
    for (const ref of headerRefs) expect(ref).toContain("->>");
    // And neither heavy column is aliased onto the row.
    expect(decl).not.toMatch(/\bAS\s+headers\b/i);
    expect(decl).not.toMatch(/\bAS\s+body_(?:text|html)\b/i);
    expect(decl).not.toMatch(/\bm\.body_html\b/);
  });

  it("sets the field explicitly rather than leaving it to a raw-row spread", () => {
    expect(storeSource).toContain("policy_denial: policyDenialOf(row[\"policy_denial\"])");
  });
});

describe("the API item projection carries the reason", () => {
  const serviceSource = readSource("service.ts");

  it("derives it from headers when it projects a full record, before dropping them", () => {
    // The signature accepts MessageRecord | MessageListRecord. A full record has no
    // policy_denial column, so without this the union's other arm would silently
    // return a row whose reason had been thrown away with the headers.
    expect(serviceSource).toMatch(/policyDenialOf\(\s*\(headers[\s\S]{0,120}policy_denial/);
  });

  it("returns the field on the list item", () => {
    expect(serviceSource).toMatch(/attachment_count,\s*policy_denial\s*\}/);
  });
});

describe("the published contract carries the reason, tolerantly", () => {
  const schemas = emailsSelfHostedOpenApi.components?.schemas as
    | Record<string, { properties?: Record<string, unknown>; required?: string[] }>
    | undefined;
  const listItem = schemas?.["MessageListItem"];

  it("declares policy_denial on MessageListItem", () => {
    expect(listItem).toBeDefined();
    expect(listItem!.properties).toHaveProperty("policy_denial");
  });

  // DELIBERATELY OPTIONAL — and this test exists to stop someone "tightening" it.
  //
  // The first cut of this change marked it required. That was verified against the
  // live deployment and it BROKE EVERY LIST READ: the running server predates the
  // field, so `emails log` died with
  //   "Self-hosted GET /v1/messages returned an invalid successful response:
  //    body.messages[0].policy_denial is required"
  // A client that refuses to list mail at all is strictly worse than one that cannot
  // explain a refusal — it converts a missing explanation into total loss of two
  // commands across the whole installed base, on every version skew.
  //
  // The server's obligation to project the field is enforced ABOVE, against the SQL
  // and the projection, where it belongs. The wire contract stays tolerant.
  it("does NOT mark it required, so an older server's list rows still validate", () => {
    expect(listItem!.required ?? []).not.toContain("policy_denial");
    // Its neighbours stay required — this is a targeted exception, not a loosening.
    expect(listItem!.required).toContain("send_state");
    expect(listItem!.required).toContain("attachment_count");
  });

  it("documents WHY it is the one optional field, so the exception is not read as an oversight", () => {
    const described = String(
      (listItem!.properties!["policy_denial"] as { description?: string }).description ?? "",
    );
    expect(described).toContain("OPTIONAL");
    expect(described.toLowerCase()).toContain("older than this field");
  });

  it("documents it as nullable, because most rows were never refused", () => {
    expect(listItem!.properties!["policy_denial"]).toMatchObject({ nullable: true });
  });
});

describe("the generated SDK type carries the reason", () => {
  it("has policy_denial on MessageListItem", () => {
    // src/selfhost.ts is generated from openapi.ts. Asserting it here means a
    // regeneration that loses the field fails a test instead of quietly narrowing
    // the client's view of a refused send.
    const sdk = readFileSync(join(HERE, "..", "..", "selfhost.ts"), "utf8");
    const decl = sdk.slice(sdk.indexOf("export interface MessageListItem"));
    const line = decl.slice(0, decl.indexOf("}"));
    // Optional in the type, matching the optional-but-nullable schema above.
    expect(line).toMatch(/"policy_denial"\?: string \| null/);
  });

  it("keeps it readable from the DETAIL response too, via headers", () => {
    // `emails show` reads GET /v1/messages/{id}, whose Message shape carries the full
    // headers object rather than the scalar. The client must therefore accept BOTH
    // sources, or the one path that always had the reason would still not show it.
    const sdk = readFileSync(join(HERE, "..", "..", "selfhost.ts"), "utf8");
    const detail = sdk.slice(sdk.indexOf("export interface Message "));
    expect(detail.slice(0, detail.indexOf("}"))).toContain('"headers"');

    const client = readFileSync(join(HERE, "..", "..", "lib", "self-hosted-mail-data-source.ts"), "utf8");
    // v1PolicyDenial prefers the list column and falls back to headers.
    expect(client).toMatch(/function v1PolicyDenial[\s\S]{0,400}headers\?\.\["policy_denial"\]/);
  });
});
