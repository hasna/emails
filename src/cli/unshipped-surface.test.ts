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
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

function localCliEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "emails-unshipped-"));
  tempDirs.push(dir);
  const homePath = join(dir, "home");
  mkdirSync(homePath, { recursive: true });
  return {
    ...process.env,
    EMAILS_MODE: "local",
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
