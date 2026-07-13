import { describe, it, expect } from "bun:test";
import { parseCsv, batchSend } from "./batch.js";
import type { Provider } from "../types/index.js";

// parseCsv is a pure re-export of csv.js and still runs locally. batchSend now
// runs on the self-hosted server (templates, suppression, provider adapters and
// the sent-mail ledger are all server-side, sending goes through /v1), so it is
// a loud stub.

describe("parseCsv", () => {
  it("parses CSV with headers", () => {
    const csv = "email,name,company\nalice@example.com,Alice,Acme\nbob@example.com,Bob,Corp";
    const rows = parseCsv(csv);
    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual({ email: "alice@example.com", name: "Alice", company: "Acme" });
    expect(rows[1]).toEqual({ email: "bob@example.com", name: "Bob", company: "Corp" });
  });

  it("handles empty values", () => {
    const csv = "email,name\nalice@example.com,";
    const rows = parseCsv(csv);
    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual({ email: "alice@example.com", name: "" });
  });

  it("returns empty array for header-only CSV", () => {
    const csv = "email,name";
    expect(parseCsv(csv)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseCsv("")).toEqual([]);
  });

  it("trims whitespace from headers and values", () => {
    const csv = " email , name \n alice@example.com , Alice ";
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual({ email: "alice@example.com", name: "Alice" });
  });
});

describe("batchSend (self-hosted stub)", () => {
  it("throws because batch sending runs on the self-hosted server", async () => {
    const provider = { id: "p1", name: "test", type: "sandbox" } as unknown as Provider;
    await expect(
      batchSend({
        csvPath: "/fake/path.csv",
        templateName: "welcome",
        from: "sender@example.com",
        provider,
        _csvContent: "email\nalice@example.com",
      }),
    ).rejects.toThrow(/batchSend is not available in the self-hosted client/);
  });
});
