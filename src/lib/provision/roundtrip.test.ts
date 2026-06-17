import { describe, it, expect } from "bun:test";
import { runRoundtrip, runSelfRoundtrip, type RoundtripDeps } from "./roundtrip.js";

/** In-memory mail server: send() drops into per-recipient inboxes. */
function fakeServer(opts: { dropTokens?: Set<string> } = {}): RoundtripDeps {
  const inboxes = new Map<string, { subject: string }[]>();
  return {
    send: async ({ to, subject }) => {
      const token = subject.match(/\[([^\]]+)\]/)?.[1];
      if (token && opts.dropTokens?.has(token)) return { messageId: "dropped" };
      const box = inboxes.get(to) ?? [];
      box.push({ subject });
      inboxes.set(to, box);
      return { messageId: `m-${to}-${box.length}` };
    },
    fetchReceived: async (mailbox) => inboxes.get(mailbox) ?? [],
  };
}

const noSleep = async () => {};

describe("runRoundtrip", () => {
  it("delivers count messages each direction around the ring (100%)", async () => {
    const deps = fakeServer();
    const report = await runRoundtrip(deps, {
      addresses: ["a@d.com", "b@d.com", "c@d.com"],
      count: 16,
      sleep: noSleep,
    });
    expect(report.success).toBe(true);
    expect(report.directions).toHaveLength(3); // ring: a->b, b->c, c->a
    expect(report.totalSent).toBe(48);
    expect(report.totalReceived).toBe(48);
    for (const dir of report.directions) {
      expect(dir.sent).toBe(16);
      expect(dir.received).toBe(16);
      expect(dir.missing).toHaveLength(0);
    }
  });

  it("each address sends 16 and receives 16 (back and forth)", async () => {
    const deps = fakeServer();
    const report = await runRoundtrip(deps, { addresses: ["a@d.com", "b@d.com", "c@d.com"], count: 16, sleep: noSleep });
    const sentBy = (a: string) => report.directions.filter((d) => d.from === a).reduce((s, d) => s + d.sent, 0);
    const recvBy = (a: string) => report.directions.filter((d) => d.to === a).reduce((s, d) => s + d.received, 0);
    for (const a of ["a@d.com", "b@d.com", "c@d.com"]) {
      expect(sentBy(a)).toBe(16);
      expect(recvBy(a)).toBe(16);
    }
  });

  it("reports missing tokens when delivery is incomplete", async () => {
    const deps = fakeServer({ dropTokens: new Set(["RT-0-3", "RT-0-7"]) });
    const report = await runRoundtrip(deps, {
      addresses: ["a@d.com", "b@d.com"],
      count: 16,
      pollAttempts: 2,
      sleep: noSleep,
    });
    expect(report.success).toBe(false);
    const aToB = report.directions.find((d) => d.from === "a@d.com")!;
    expect(aToB.received).toBe(14);
    expect(aToB.missing.sort()).toEqual(["RT-0-3", "RT-0-7"]);
  });

  it("polls until tokens arrive (eventual delivery)", async () => {
    // Messages appear only on the 2nd fetch.
    const inbox: { subject: string }[] = [];
    let pending: { subject: string }[] = [];
    let fetches = 0;
    const deps: RoundtripDeps = {
      send: async ({ subject }) => { pending.push({ subject }); return { messageId: "x" }; },
      fetchReceived: async () => {
        fetches++;
        if (fetches >= 2) { inbox.push(...pending); pending = []; }
        return inbox;
      },
    };
    const report = await runRoundtrip(deps, { addresses: ["a@d.com", "b@d.com"], count: 4, pollAttempts: 5, sleep: noSleep });
    expect(report.success).toBe(true);
  });

  it("requires at least 2 addresses", async () => {
    await expect(runRoundtrip(fakeServer(), { addresses: ["solo@d.com"], count: 1, sleep: noSleep })).rejects.toThrow(/at least 2/);
  });
});

describe("runSelfRoundtrip", () => {
  it("delivers one address to itself", async () => {
    const report = await runSelfRoundtrip(fakeServer(), {
      address: "solo@d.com",
      count: 1,
      sleep: noSleep,
    });

    expect(report.success).toBe(true);
    expect(report.directions).toEqual([
      { from: "solo@d.com", to: "solo@d.com", sent: 1, received: 1, missing: [] },
    ]);
    expect(report.totalSent).toBe(1);
    expect(report.totalReceived).toBe(1);
  });

  it("reports missing self-delivery tokens", async () => {
    const report = await runSelfRoundtrip(fakeServer({ dropTokens: new Set(["RT-0-0"]) }), {
      address: "solo@d.com",
      count: 1,
      pollAttempts: 2,
      sleep: noSleep,
    });

    expect(report.success).toBe(false);
    expect(report.directions[0]?.missing).toEqual(["RT-0-0"]);
  });
});
