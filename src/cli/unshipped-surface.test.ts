// End-to-end truthfulness contract for surfaces this build does NOT implement.
// These spawn the REAL CLI (bun src/cli/index.tsx) in local mode against a
// throwaway HOME + in-memory DB, because the failures they guard against were
// all "the source looks fine, the shipped binary lies" bugs:
//
//   * `emails daemon status` printed "Start provisioner: emails provision
//     daemon ..." — a command whose action is an unconditional throw.
//   * `emails provision *` claimed it "runs on the self-hosted server"; the
//     server has no provisioning route and its container runs no reconciler.
//   * `emails domain setup-brandsight` was advertised in --help with a full
//     option set while its only implementation (src/lib/brandsight-dns.ts) was
//     unreachable from every entrypoint.
//   * fifteen domain/address commands threw ONE sentence — "is not available in
//     the self-hosted client; it runs on the self-hosted server" — from a shared
//     `serverOnly()` helper. Unconditional, so it fired in local mode; and there
//     is no server route behind any of them, so it named a cause that does not
//     exist. That is the class the CONTRACT below generalises: a refusal may
//     never name a deployment mode, because the mode is never the reason.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanCliRefusals } from "../test-support/cli-refusals.js";
import { isCommandAvailableInMode } from "../lib/status-commands.js";

const tempDirs: string[] = [];

function localCliEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "emails-unshipped-"));
  tempDirs.push(dir);
  const homePath = join(dir, "home");
  mkdirSync(homePath, { recursive: true });
  return {
    ...process.env,
    EMAILS_DB_PATH: join(dir, "emails.db"),
    HOME: homePath,
    NO_COLOR: "1",
  };
}

function runCli(args: string[]) {
  const result = Bun.spawnSync({
    cmd: ["bun", "src/cli/index.tsx", ...args],
    cwd: process.cwd(),
    env: localCliEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const decoder = new TextDecoder();
  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}

interface CliError { error: { message: string; code: string; fix_commands: string[] } }

afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("unshipped CLI surfaces tell the truth (live)", () => {
  it("emails provision never claims a self-hosted server implements it", () => {
    const result = runCli(["--json", "provision", "status"]);
    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stderr) as CliError;

    expect(payload.error.message).toContain("emails provision status is not implemented in this build");
    expect(payload.error.message).toContain("emails domain adopt");
    expect(payload.error.message).toContain("emails aws setup-inbound");
    // The two false claims that shipped before.
    expect(payload.error.message).not.toContain("not available in the self-hosted client");
    expect(payload.error.message).not.toContain("runs on the self-hosted server");
    // Machine-readable guidance must not loop back into the unimplemented surface.
    expect(payload.error.fix_commands.length).toBeGreaterThan(0);
    for (const command of payload.error.fix_commands) expect(command).not.toContain("emails provision");
  });

  it("emails daemon status advertises only commands that exist", () => {
    const result = runCli(["--json", "daemon", "status"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      queue: { drainable: boolean };
      start_commands: Record<string, string>;
    };

    // Nothing drains the provisioning queue in this build; say so, do not point
    // at `emails provision daemon`.
    expect(payload.queue.drainable).toBe(false);
    const advertised = Object.values(payload.start_commands);
    expect(advertised.length).toBeGreaterThan(0);
    for (const command of advertised) expect(command).not.toContain("emails provision");

    // Every advertised command must be a real, registered subcommand.
    for (const command of advertised) {
      const words = command.split(" ").filter((word) => !word.startsWith("-") && !word.startsWith("<"));
      expect(words[0]).toBe("emails");
      const help = runCli([...words.slice(1), "--help"]);
      expect(help.exitCode, `${command}: ${help.stderr}`).toBe(0);
      expect(help.stderr).not.toContain("unknown command");
    }
  });

  it("emails domain no longer advertises the removed BrandSight integration", () => {
    const help = runCli(["domain", "--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).not.toContain("setup-brandsight");
    expect(help.stdout.toLowerCase()).not.toContain("brandsight");

    const invoked = runCli(["--json", "domain", "setup-brandsight", "example.com"]);
    expect(invoked.exitCode).toBe(1);
    const payload = JSON.parse(invoked.stderr) as CliError;
    expect(payload.error.code).toBe("unknown_command");
  });

  // ── the CLASS guard ─────────────────────────────────────────────────────────
  //
  // One assertion over EVERY unconditional refusal the CLI ships, derived from
  // the source rather than listed here, so a new one cannot be added in the old
  // shape. `src/test-support/cli-refusals.ts` is the oracle: it parses the
  // `notImplementedAnywhere("…")` / `serverOnly("…")` call sites out of
  // src/cli/commands/*.ts, and a call site in a SHARED module (not
  // `*.remote.ts` / `*.local.ts`, which index.tsx picks between) throws in every
  // configuration.
  //
  // Each command needs real arguments, because commander rejects a missing
  // `requiredOption` before the action runs and we would then be asserting
  // against "required option not specified" instead of the refusal. The table is
  // asserted to COVER the scan, so adding a refusal without a probe fails here.
  const PROBES: Record<string, string[]> = {
    "emails domain connect": ["domain", "connect", "example.com", "--provider", "p1"],
    "emails domains connect": ["domains", "connect", "example.com", "--provider", "p1"],
    "emails domain verify": ["domain", "verify", "example.com"],
    "emails domains verify": ["domains", "verify", "example.com"],
    "emails domain status": ["domain", "status"],
    "emails domains enable-inbound": ["domains", "enable-inbound", "example.com"],
    "emails domains enable-outbound": ["domains", "enable-outbound", "example.com"],
    "emails domains disable-outbound": ["domains", "disable-outbound", "example.com"],
    "emails domain setup-cloudflare": ["domain", "setup-cloudflare", "example.com", "--provider", "p1"],
    "emails domain setup": [
      "domain", "setup", "example.com", "--provider", "p1", "--email", "ops@example.com",
      "--first-name", "A", "--last-name", "B", "--phone", "+1.5551234567",
      "--address", "1 Main St", "--city", "Town", "--country", "US", "--zip", "12345",
    ],
    "emails address provision": ["address", "provision", "ops@example.com", "--provider", "p1"],
    "emails provision status": ["provision", "status"],
    "emails provision address": ["provision", "address", "ops@example.com", "--provider", "p1"],
    "emails provision domain": ["provision", "domain", "example.com", "--provider", "p1"],
    "emails provision up": ["provision", "up", "example.com", "--provider", "p1"],
    "emails provision roundtrip": ["provision", "roundtrip", "--domain", "example.com", "--provider", "p1"],
    "emails provision daemon": ["provision", "daemon", "--provider", "p1"],
    "emails provision retry": ["provision", "retry", "example.com"],
  };

  // The CLAIMS that made the old message a lie — not the words. Naming a mode is
  // fine when the sentence is true ("the server exposes no provisioning route" is
  // the honest finding). What is banned is offering the mode as the CAUSE:
  // asserting the capability lives in the other configuration, or telling the
  // operator to switch. Every pattern is proved to still fire below.
  const MODE_BLAME: RegExp[] = [
    /not available in the self[\s-]?hosted client/i,
    /runs on the self[\s-]?hosted server/i,
    /available in the self[\s-]?hosted (?:client|server)/i,
    /available in (?:local|self_hosted) mode/i,
    /is (?:local|self[\s-]?hosted)[\s-]mode[\s-]only/i,
    // Lower-cased ON PURPOSE, matched case-insensitively: the mode-axis ratchet
    // (src/mode-axis-ratchet.test.ts) counts the upper-case spelling of the mode
    // variable ANYWHERE in the tree and holds that count at a ceiling. A guard
    // against naming the variable must not itself add an occurrence of it.
    /(?:set|use) emails_mode/i,
    /switch to (?:local|self[\s-]?hosted)/i,
  ];

  // The exact sentences that shipped. Without this, a typo in any pattern above
  // silently turns the ban into a no-op while the suite stays green — the failure
  // mode this repo has already shipped twice.
  const HISTORICAL_LIES = [
    "emails domain check is not available in the self-hosted client; it runs on the self-hosted server.",
    "emails aws setup-inbound is not available in the self-hosted client; it runs on the self-hosted server.",
    "--to-group is not available in the self-hosted client without a self-hosted group-members send API.",
    // febe87e's wording for the same command, which blamed the mode twice: once
    // as a label and once as an instruction. Spelled with the lower-case
    // variable name for the ratchet reason above; the pattern is
    // case-insensitive, so it still catches the upper-case text that shipped.
    "`emails aws setup-inbound` is local-mode-only and unavailable in self_hosted API-only mode. "
      + "Use the self-hosted server/operator API/workers for inbound AWS setup, or set emails_mode=local intentionally.",
  ];

  it("the mode-blame ban still fires against the messages that shipped", () => {
    for (const lie of HISTORICAL_LIES) {
      expect(MODE_BLAME.some((pattern) => pattern.test(lie)), lie).toBe(true);
    }
    // Counter-control: the sanctioned shape must NOT trip the ban, or the guard
    // would forbid the honest finding along with the lie.
    const honest = "emails provision status is not implemented in this build: there is no local "
      + "provisioning orchestrator and the self-hosted server exposes no provisioning route.";
    for (const pattern of MODE_BLAME) expect(pattern.test(honest), String(pattern)).toBe(false);
  });

  const sharedRefusals = scanCliRefusals().filter((refusal) => refusal.shared);

  it("has a probe for every unconditional refusal the CLI ships", () => {
    // Positive control first: an empty or mis-parsed scan would make every
    // assertion below pass over nothing.
    expect(sharedRefusals.length).toBeGreaterThan(10);
    const files = new Set(sharedRefusals.map((refusal) => refusal.file));
    expect(files).toContain("domain.ts");
    expect(files).toContain("address.ts");
    expect(files).toContain("provision.ts");

    const unprobed = sharedRefusals
      .map((refusal) => refusal.command)
      .filter((command) => !PROBES[command]);
    expect(unprobed, "add these to PROBES so the contract below covers them:\n"
      + unprobed.join("\n")).toEqual([]);
    // And nothing stale: a probe for a command that no longer refuses would keep
    // asserting a refusal that has become a working command.
    const scanned = new Set(sharedRefusals.map((refusal) => refusal.command));
    const stale = Object.keys(PROBES).filter((command) => !scanned.has(command));
    expect(stale, "these no longer refuse; drop the probe:\n" + stale.join("\n")).toEqual([]);
  });

  for (const refusal of sharedRefusals) {
    it(`${refusal.command} explains what is missing without blaming a mode`, () => {
      const result = runCli(["--json", ...(PROBES[refusal.command] ?? [])]);
      expect(result.exitCode, result.stdout + result.stderr).toBe(1);
      const payload = JSON.parse(result.stderr) as CliError;
      const message = payload.error.message;

      // Says what it is: unshipped, not misrouted.
      expect(message).toContain(`${refusal.command} is not implemented in this build`);
      // The regression, stated as a ban on the CLAIM rather than a list of old
      // strings.
      for (const pattern of MODE_BLAME) {
        expect(message, `${refusal.command} blames a mode (${pattern})`).not.toMatch(pattern);
      }
      // "not implemented" alone leaves the operator stuck: every refusal must
      // name at least one command, and every command it names must RUN. The
      // quoting convention is load-bearing — a single-quoted `emails …` is a
      // promise, so a refusal may not promise another refusal.
      const promised = [...message.matchAll(/'(emails [^']+)'/g)].map((match) => match[1]!);
      expect(promised.length, `${refusal.command} names no alternative`).toBeGreaterThan(0);
      for (const command of promised) {
        for (const mode of ["local", "self_hosted"] as const) {
          expect(
            isCommandAvailableInMode(command, mode),
            `${refusal.command} promises '${command}', which refuses in ${mode}`,
          ).toBe(true);
        }
      }
      // Machine-readable guidance gets the same treatment.
      expect(payload.error.fix_commands.length).toBeGreaterThan(0);
      for (const command of payload.error.fix_commands) {
        expect(isCommandAvailableInMode(command, "local"), command).toBe(true);
      }
    });
  }

  // The hole the two guards above CANNOT see. `emails aws setup-inbound` threw
  // the same mode-blaming sentence from an INLINE `throw new Error(...)`, so it
  // was invisible to every scan keyed on the refusal helpers — including the
  // registry coverage check — and stayed broken while `emails provision *` was
  // fixed to point AT it. `emails send --to-group` was inline too. So this scans
  // the shared command modules as text, not through a helper name.
  it("no shared command module blames a mode in a string it prints", () => {
    const commandsDir = join(import.meta.dir, "commands");
    const shared = readdirSync(commandsDir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      // `*.remote.ts` / `*.local.ts` are the two ARMS: index.tsx loads one per
      // configuration, so a refusal there names the mode it is actually running
      // in and is allowed to say so.
      .filter((name) => !name.endsWith(".remote.ts") && !name.endsWith(".local.ts"));
    expect(shared.length).toBeGreaterThan(10);
    expect(shared).toContain("aws.ts");
    expect(shared).toContain("send.ts");
    expect(shared).toContain("domain.ts");

    const offenders: string[] = [];
    for (const name of shared) {
      // Comments are documentation OF the defect — domain.ts and address.ts both
      // quote the retired sentence on purpose — so only code is scanned.
      const code = readFileSync(join(commandsDir, name), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
      for (const [index, line] of code.split("\n").entries()) {
        const withoutTrailingComment = line.replace(/\/\/.*$/, "");
        for (const pattern of MODE_BLAME) {
          if (pattern.test(withoutTrailingComment)) {
            offenders.push(`${name}:${index + 1}: ${withoutTrailingComment.trim()}`);
          }
        }
      }
    }
    expect(offenders, "a shared command module ships in EVERY configuration, so a "
      + "string it prints may not name one as the reason:\n" + offenders.join("\n")).toEqual([]);
  });

  // The other half of the fix: four commands left the refusal set entirely
  // because their implementations already existed and were merely unwired.
  it("emails domain dns and check run instead of refusing", () => {
    for (const noun of ["domain", "domains"]) {
      const dns = runCli(["--json", noun, "dns", "example.com"]);
      expect(dns.exitCode, dns.stderr).toBe(0);
      const records = (JSON.parse(dns.stdout) as { records: { purpose: string }[] }).records;
      expect(records.map((record) => record.purpose)).toEqual(["SPF", "DMARC"]);
    }
    // `check` resolves live DNS, so assert the SHAPE rather than a verdict that
    // depends on what example.com publishes today.
    const check = runCli(["--json", "domain", "check", "example.com"]);
    expect(check.exitCode, check.stderr).toBe(0);
    const payload = JSON.parse(check.stdout) as {
      domain: string;
      records: unknown[];
      signals: Record<string, unknown>;
      mx: { owner: string };
    };
    expect(payload.domain).toBe("example.com");
    expect(payload.records.length).toBeGreaterThan(0);
    expect(Object.keys(payload.signals)).toContain("dkim");
    expect(payload.mx.owner).toBeTruthy();
    // Three CLI spawns plus live DNS resolution: measured 5.2-7.4 s against
    // the 5 s default across independent runs (including on unmodified main),
    // so the default budget gauges machine load rather than the contract.
  }, 60_000);

  it("emails inbound stays unregistered (superseded by emails inbox)", () => {
    // `inbound` was folded into `inbox` in the CLI restructure; its command
    // files lingered for months as dead code. `inbox` covers the whole surface.
    const invoked = runCli(["--json", "inbound", "list"]);
    expect(invoked.exitCode).toBe(1);
    expect((JSON.parse(invoked.stderr) as CliError).error.code).toBe("unknown_command");

    const inboxHelp = runCli(["inbox", "--help"]);
    expect(inboxHelp.exitCode).toBe(0);
    for (const replacement of ["list", "read", "clear", "listen", "open", "unread-count"]) {
      expect(inboxHelp.stdout).toContain(`  ${replacement}`);
    }
  });
});
