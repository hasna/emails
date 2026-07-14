import { describe, expect, it } from "bun:test";
import { processForwardingRules } from "./forwarding.remote.js";

// App-level forwarding reads local inbound message bodies, sends copies through
// provider adapters, and writes the sent-mail ledger + forwarding delivery
// records. All server-side in the self-hosted client, so this is a loud stub.
describe("processForwardingRules (self-hosted stub)", () => {
  it("throws because app-level forwarding runs on the self-hosted server", async () => {
    await expect(processForwardingRules()).rejects.toThrow(
      /processForwardingRules is not available in the self-hosted client/,
    );
  });

  it("throws before touching any local state even with an injected sender", async () => {
    await expect(
      processForwardingRules({
        send: async () => {
          throw new Error("send should never be invoked");
        },
      }),
    ).rejects.toThrow(/app-level forwarding runs on the self-hosted server/);
  });
});
