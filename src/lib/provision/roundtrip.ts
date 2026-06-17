/**
 * Round-trip mail test — the live acceptance check.
 *
 * Arranges the addresses in a ring and, for each address, sends `count` messages
 * with unique tokens to its neighbour, then polls the recipient's mailbox until
 * every token is observed. "Back and forth per address": each address both sends
 * and receives `count` messages. 3 addresses × 16 = 48 per domain.
 *
 * Pure orchestration with injected `send` / `fetchReceived`, so it is fully
 * unit-testable; the CLI wires real SES send + S3/SQLite inbound fetch.
 */

export interface RoundtripDeps {
  send(opts: { from: string; to: string; subject: string; text: string }): Promise<{ messageId: string }>;
  /** All messages currently observed in `mailbox` (subjects suffice for matching). */
  fetchReceived(mailbox: string): Promise<{ subject: string }[]>;
}

export interface RoundtripOptions {
  addresses: string[];
  count: number;
  tokenPrefix?: string;
  /** How many times to poll for receipt before giving up (default 12). */
  pollAttempts?: number;
  /** Delay between polls in ms (default 5000). */
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SelfRoundtripOptions {
  address: string;
  count: number;
  tokenPrefix?: string;
  /** How many times to poll for receipt before giving up (default 12). */
  pollAttempts?: number;
  /** Delay between polls in ms (default 5000). */
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DirectionReport {
  from: string;
  to: string;
  sent: number;
  received: number;
  missing: string[];
}

export interface RoundtripReport {
  directions: DirectionReport[];
  totalSent: number;
  totalReceived: number;
  success: boolean;
}

export async function runRoundtrip(deps: RoundtripDeps, opts: RoundtripOptions): Promise<RoundtripReport> {
  const { addresses, count } = opts;
  if (addresses.length < 2) throw new Error("roundtrip requires at least 2 addresses");

  const prefix = opts.tokenPrefix ?? "RT";
  const pollAttempts = opts.pollAttempts ?? 12;
  const pollIntervalMs = opts.pollIntervalMs ?? 5000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const directions: DirectionReport[] = [];

  for (let i = 0; i < addresses.length; i++) {
    const from = addresses[i]!;
    const to = addresses[(i + 1) % addresses.length]!;

    const tokens: string[] = [];
    for (let n = 0; n < count; n++) {
      const token = `${prefix}-${i}-${n}`;
      tokens.push(token);
      await deps.send({
        from,
        to,
        subject: `[${token}] roundtrip ${from} -> ${to}`,
        text: `Provisioning round-trip probe. token=${token}`,
      });
    }

    const missing = await waitForTokens(deps, to, tokens, pollAttempts, pollIntervalMs, sleep);
    directions.push({ from, to, sent: count, received: count - missing.length, missing });
  }

  const totalSent = directions.reduce((s, d) => s + d.sent, 0);
  const totalReceived = directions.reduce((s, d) => s + d.received, 0);
  return { directions, totalSent, totalReceived, success: totalSent === totalReceived };
}

export async function runSelfRoundtrip(deps: RoundtripDeps, opts: SelfRoundtripOptions): Promise<RoundtripReport> {
  const { address, count } = opts;
  if (!address) throw new Error("self roundtrip requires an address");

  const prefix = opts.tokenPrefix ?? "RT";
  const pollAttempts = opts.pollAttempts ?? 12;
  const pollIntervalMs = opts.pollIntervalMs ?? 5000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const tokens: string[] = [];
  for (let n = 0; n < count; n++) {
    const token = `${prefix}-0-${n}`;
    tokens.push(token);
    await deps.send({
      from: address,
      to: address,
      subject: `[${token}] roundtrip ${address} -> ${address}`,
      text: `Provisioning round-trip probe. token=${token}`,
    });
  }

  const missing = await waitForTokens(deps, address, tokens, pollAttempts, pollIntervalMs, sleep);
  const directions = [{ from: address, to: address, sent: count, received: count - missing.length, missing }];
  const totalSent = count;
  const totalReceived = count - missing.length;
  return { directions, totalSent, totalReceived, success: totalSent === totalReceived };
}

async function waitForTokens(
  deps: RoundtripDeps,
  mailbox: string,
  tokens: string[],
  attempts: number,
  intervalMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<string[]> {
  let remaining = new Set(tokens);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const received = await deps.fetchReceived(mailbox);
    const seen = received.map((m) => m.subject).join("\n");
    for (const token of [...remaining]) {
      if (seen.includes(`[${token}]`)) remaining.delete(token);
    }
    if (remaining.size === 0) break;
    if (attempt < attempts - 1) await sleep(intervalMs);
  }
  return [...remaining];
}
