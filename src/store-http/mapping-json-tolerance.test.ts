// The seam declares `nameservers_json?: string[]` — a DECODED array — while
// server releases through 1.3.x serialize the column into responses as a
// JSON-encoded STRING (`"[]"` rather than `[]`). The mapper used to copy the
// field through unvalidated, so the string form leaked into `DomainRecord`
// as-is and every reader met a value the seam type says cannot exist.
//
// The tolerance under test: the string form is decoded ONCE and held to the
// declared shape; a value that is neither the declared array of strings nor a
// string decoding to one is a FAULT in the mapper's own refusal style, never a
// silent pass-through and never a default. Absent stays absent.

import { describe, expect, test } from "bun:test";
import { domainRecord } from "./mapping.js";
import { EmailsApiFault } from "./outcome.js";

function domainRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "domain-1",
    domain: "example.com",
    status: "pending",
    provider: null,
    verified: false,
    notes: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const NON_ARRAY_FAULT = "the Emails API answered listDomains with a non-array nameservers_json";
const NON_STRING_ENTRY_FAULT =
  "the Emails API answered listDomains with a non-string entry in nameservers_json";

describe("domainRecord serialized nameservers_json tolerance", () => {
  test("decodes a string-encoded empty list", () => {
    const record = domainRecord(domainRow({ nameservers_json: "[]" }), "listDomains");
    expect(record.nameservers_json).toEqual([]);
  });

  test("decodes a string-encoded nameserver list", () => {
    const record = domainRecord(
      domainRow({ nameservers_json: '["ns1.example.test","ns2.example.test"]' }),
      "listDomains",
    );
    expect(record.nameservers_json).toEqual(["ns1.example.test", "ns2.example.test"]);
  });

  test("passes the decoded array form through", () => {
    const record = domainRecord(
      domainRow({ nameservers_json: ["ns1.example.test"] }),
      "listDomains",
    );
    expect(record.nameservers_json).toEqual(["ns1.example.test"]);
  });

  test("an absent field stays absent", () => {
    const record = domainRecord(domainRow(), "listDomains");
    expect("nameservers_json" in record).toBe(false);
  });

  test.each([
    ["a string that is not JSON", "not json"],
    ["a string of JSON with the wrong shape", '{"ns":"ns1.example.test"}'],
    ["a double-encoded string", '"[]"'],
    ["a number", 42],
    ["a null", null],
  ])("faults on %s", (_label, value) => {
    expect(() => domainRecord(domainRow({ nameservers_json: value }), "listDomains"))
      .toThrow(EmailsApiFault);
    expect(() => domainRecord(domainRow({ nameservers_json: value }), "listDomains"))
      .toThrow(NON_ARRAY_FAULT);
  });

  test.each([
    ["decoded", ["ns1.example.test", 2]],
    ["string-encoded", '["ns1.example.test",2]'],
  ])("faults on a non-string entry in the %s form", (_label, value) => {
    expect(() => domainRecord(domainRow({ nameservers_json: value }), "listDomains"))
      .toThrow(EmailsApiFault);
    expect(() => domainRecord(domainRow({ nameservers_json: value }), "listDomains"))
      .toThrow(NON_STRING_ENTRY_FAULT);
  });
});
