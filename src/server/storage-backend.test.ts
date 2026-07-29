import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RETIRED_SERVER_MODE_SETTINGS,
  SERVER_DATABASE_URL_SETTING,
  ServerStorageConfigurationError,
  resolveServerStorageBackend,
} from "./storage-backend.js";

const root = join(import.meta.dir, "..", "..");

/**
 * The environment `emails-serve` gets in a hermetic run is NOT empty — the suite
 * harness exports the retired deployment word into every child (scripts/run-hermetic-tests.sh
 * sets it, and a tmux global environment can too). Every case below therefore builds its
 * environment from scratch rather than spreading `process.env`, because a case that
 * inherited the word would be measuring the harness rather than the resolution.
 */
const bare: NodeJS.ProcessEnv = {};

describe("emails-serve storage backend", () => {
  it("answers postgresql when, and only when, the database URL is configured", () => {
    expect(resolveServerStorageBackend({ [SERVER_DATABASE_URL_SETTING]: "postgres://db.invalid/emails" }))
      .toBe("postgresql");
    expect(resolveServerStorageBackend(bare)).toBe("sqlite");
    // A blank value is not a configuration. The deploy path writes this variable from a
    // secret, and an unresolved secret arrives as the empty string rather than absent.
    expect(resolveServerStorageBackend({ [SERVER_DATABASE_URL_SETTING]: "   " })).toBe("sqlite");
  });

  it("refuses the retired deployment word instead of ignoring it, and names the replacement", () => {
    for (const setting of RETIRED_SERVER_MODE_SETTINGS) {
      for (const value of ["self_hosted", "self-hosted", "local", "cloud", "remote", "hybrid", "typo"]) {
        let caught: unknown;
        try {
          resolveServerStorageBackend({ [setting]: value });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(ServerStorageConfigurationError);
        const message = (caught as Error).message;
        // The refusal has to name BOTH the variable to delete and the variable to set;
        // a refusal that only says "unsupported" leaves the operator guessing.
        expect(message).toContain(setting);
        expect(message).toContain(SERVER_DATABASE_URL_SETTING);
        expect((caught as ServerStorageConfigurationError).settings).toContain(setting);
      }
    }
  });

  it("refuses the retired word even when the database URL agrees with it", () => {
    // The word is not a tie-breaker that happens to be redundant here — it is deleted.
    // Accepting it when it agrees would keep the surface alive in exactly the
    // configuration every deployed task definition already uses, which is the one
    // configuration that has to stop carrying it.
    expect(() => resolveServerStorageBackend({
      EMAILS_MODE: "self_hosted",
      [SERVER_DATABASE_URL_SETTING]: "postgres://db.invalid/emails",
    })).toThrow(ServerStorageConfigurationError);
  });

  it("never reports a value in the refusal, because the database URL carries a password", () => {
    let caught: unknown;
    try {
      resolveServerStorageBackend({
        EMAILS_MODE: "self_hosted",
        [SERVER_DATABASE_URL_SETTING]: "postgres://operator:s3cret-shibboleth@db.invalid/emails",
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).not.toContain("s3cret-shibboleth");
    expect((caught as Error).message).not.toContain("self_hosted");
  });

  it("is the ONLY place the server decides its backend, and decides it from storage alone", () => {
    // The load-bearing property, asserted the way src/store-resolution.test.ts asserts
    // its own: this module may not read a deployment word to ANSWER, only to refuse.
    // A resolver that consulted the word to choose would re-create the axis being deleted.
    const source = readFileSync(join(import.meta.dir, "storage-backend.ts"), "utf8");
    const body = source.slice(source.indexOf("export function resolveServerStorageBackend"));
    expect(body).not.toMatch(/===\s*["'](?:self_hosted|local|cloud|remote|hybrid)["']/);
    expect(body).not.toMatch(/\bresolveEmailsMode/);
    expect(body).not.toMatch(/\bisSelfHostedMode\b/);
  });

  it("leaves no server module reading the retired word to choose a backend", () => {
    // A POSITIVE CONTROL for the absence claim: the same scan run against a fixture that
    // DOES contain the offending read must find it, or this assertion proves nothing.
    const offending = 'const mode = resolveEmailsModeSelection().mode;\nif (mode === "self_hosted") {}';
    const scan = (text: string): boolean =>
      /resolveEmailsMode(?:Selection)?\(\)/.test(text) || /\bgetEmailsMode\(\)/.test(text);
    expect(scan(offending)).toBe(true);

    for (const relative of ["src/server/index.ts", "src/server/bind-options.ts", "src/server/self-hosted/env.ts", "src/server/self-hosted/migrate.ts"]) {
      expect(scan(readFileSync(join(root, relative), "utf8"))).toBe(false);
    }
  });
});
