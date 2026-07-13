import { describe, expect, it } from "bun:test";
import { syncProvider, syncAll } from "./sync.js";

// Provider event sync (pulling remote delivery events and ingesting them into
// the delivery events table, updating contact bounce/complaint counts) runs on
// the self-hosted server. Both client entrypoints are loud stubs.
describe("syncProvider (self-hosted stub)", () => {
  it("throws because provider event ingestion runs on the self-hosted server", async () => {
    await expect(syncProvider("provider-1")).rejects.toThrow(
      /syncProvider is not available in the self-hosted client/,
    );
  });
});

describe("syncAll (self-hosted stub)", () => {
  it("throws because provider event ingestion runs on the self-hosted server", async () => {
    await expect(syncAll()).rejects.toThrow(
      /syncAll is not available in the self-hosted client/,
    );
  });
});
