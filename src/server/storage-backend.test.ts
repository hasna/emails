import { beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RETIRED_SERVER_MODE_SETTINGS,
  SERVER_DATABASE_URL_SETTING,
  ServerStorageConfigurationError,
  resetRetiredSettingNoticeForTests,
  resolveServerStorageBackend,
} from "./storage-backend.js";

const root = join(import.meta.dir, "..", "..");
const POSTGRES = "postgres://operator.invalid/emails";

/**
 * The bare retired setting, read by ROLE from the owning module rather than spelled again.
 *
 * Not style: `src/mode-axis-ratchet.test.ts` counts every occurrence of that variable's name
 * anywhere in the tree as a plain substring, the count may only fall, and a suite about the
 * variable is the easiest place to push it back up. One definition site, nine uses.
 */
const MODE_SETTING = RETIRED_SERVER_MODE_SETTINGS[0];

/**
 * The environment `emails-serve` gets in a hermetic run is NOT empty — the harness exports
 * the retired deployment word into every child (scripts/run-hermetic-tests.sh sets it, and a
 * terminal multiplexer's global environment can too). Every case below therefore builds its
 * environment from scratch rather than spreading `process.env`, because a case that inherited
 * the word would be measuring the harness rather than the resolution.
 */
const bare: NodeJS.ProcessEnv = {};

/** Collects the notice instead of writing it to stderr, so a case can assert on it. */
function announced(env: NodeJS.ProcessEnv): { backend: string; notices: string[] } {
  const notices: string[] = [];
  const backend = resolveServerStorageBackend(env, { announce: (m) => notices.push(m) });
  return { backend, notices };
}

describe("emails-serve storage backend", () => {
  beforeEach(() => {
    resetRetiredSettingNoticeForTests();
  });

  it("answers postgresql when, and only when, the database URL is configured", () => {
    expect(resolveServerStorageBackend({ [SERVER_DATABASE_URL_SETTING]: POSTGRES })).toBe("postgresql");
    expect(resolveServerStorageBackend(bare)).toBe("sqlite");
    // A blank value is not a configuration. The deploy path writes this variable from a
    // secret, and an unresolved secret arrives as the empty string rather than absent.
    expect(resolveServerStorageBackend({ [SERVER_DATABASE_URL_SETTING]: "   " })).toBe("sqlite");
  });

  it("refuses a retired value that never selected anything here, naming the replacement", () => {
    for (const setting of RETIRED_SERVER_MODE_SETTINGS) {
      // `self-hosted` and `selfhosted` are in here on purpose: the manifests spelled the
      // concept with a hyphen and the code enum with an underscore, so a guard written against
      // one spelling misses the other.
      for (const value of ["cloud", "remote", "hybrid", "self-hosted", "selfhosted", "typo", "LOCALE"]) {
        let caught: unknown;
        try {
          resolveServerStorageBackend({ [setting]: value, [SERVER_DATABASE_URL_SETTING]: POSTGRES });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(ServerStorageConfigurationError);
        const message = (caught as Error).message;
        expect(message).toContain(setting);
        expect(message).toContain(SERVER_DATABASE_URL_SETTING);
        expect((caught as ServerStorageConfigurationError).settings).toContain(setting);
      }
    }
  });

  it("refuses a retired value that CONTRADICTS the storage configuration, and names both", () => {
    // These two were the silent wrong-store reads. `local` beside a configured database used to
    // serve the SQLite dashboard while PostgreSQL sat configured and unused; `self_hosted` with
    // no database URL used to fail several layers down in the pool's words.
    for (const [value, env] of [
      ["local", { [MODE_SETTING]: "local", [SERVER_DATABASE_URL_SETTING]: POSTGRES }],
      ["self_hosted", { [MODE_SETTING]: "self_hosted" }],
    ] as const) {
      let caught: unknown;
      try {
        resolveServerStorageBackend(env as NodeJS.ProcessEnv);
      } catch (error) {
        caught = error;
      }
      expect(caught, `contradiction with ${value} was not refused`)
        .toBeInstanceOf(ServerStorageConfigurationError);
      expect((caught as ServerStorageConfigurationError).settings)
        .toEqual([MODE_SETTING, SERVER_DATABASE_URL_SETTING]);
      expect((caught as Error).message).toContain("no precedence rule");
    }
  });

  it("tolerates an AGREEING retired value but says out loud that it decides nothing", () => {
    // WHY TOLERATED AT ALL: sixteen `emails` CLI families still route on this word, so one shell
    // legitimately exports it for the client and runs the server from the same place. Refusing
    // would break the hermetic harness, the container smoke, and the two-block setup in
    // docs/SELF_HOSTED_RUNTIME.md — configurations that work today.
    const sqlite = announced({ [MODE_SETTING]: "local" });
    expect(sqlite.backend).toBe("sqlite");
    expect(sqlite.notices).toHaveLength(1);

    resetRetiredSettingNoticeForTests();
    const postgres = announced({ [MODE_SETTING]: "self_hosted", [SERVER_DATABASE_URL_SETTING]: POSTGRES });
    expect(postgres.backend).toBe("postgresql");
    expect(postgres.notices).toHaveLength(1);

    // WHAT THE NOTICE HAS TO SAY, because "removed the word and kept the hole" is precisely a
    // retired setting that is ignored without comment.
    for (const notice of [...sqlite.notices, ...postgres.notices]) {
      expect(notice).toContain(MODE_SETTING);
      expect(notice).toContain("IGNORED");
      expect(notice).toContain(SERVER_DATABASE_URL_SETTING);
    }
  });

  it("announces once per process, not once per resolution", () => {
    // `getSelfHostedPool` resolves on every acquisition. A per-call notice would bury the real
    // log output of a long-lived service, which is how a warning stops being read.
    const notices: string[] = [];
    const env = { [MODE_SETTING]: "local" };
    for (let i = 0; i < 5; i++) {
      resolveServerStorageBackend(env, { announce: (m) => notices.push(m) });
    }
    expect(notices).toHaveLength(1);
  });

  it("never reports a value, because the database URL carries a password", () => {
    let caught: unknown;
    try {
      // A DISTINCTIVE value, not `cloud`: the refusal legitimately names the retired
      // vocabulary in its prose, so asserting the absence of `cloud` would be asserting that
      // the message says less than it should. What must never appear is the OPERATOR'S value.
      resolveServerStorageBackend({
        [MODE_SETTING]: "shibboleth-mode-9f2a",
        [SERVER_DATABASE_URL_SETTING]: "postgres://operator:s3cret-shibboleth@db.invalid/emails",
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).not.toContain("s3cret-shibboleth");
    expect((caught as Error).message).not.toContain("shibboleth-mode-9f2a");

    const { notices } = announced({
      [MODE_SETTING]: "self_hosted",
      [SERVER_DATABASE_URL_SETTING]: "postgres://operator:s3cret-shibboleth@db.invalid/emails",
    });
    expect(notices[0]).not.toContain("s3cret-shibboleth");
  });

  it("decides from storage alone — the retired word is only ever a refusal or a notice", () => {
    // The load-bearing property, asserted the way src/store-resolution.test.ts asserts its own.
    // `backend` is computed BEFORE the retired setting is looked at, and the assertion below
    // pins that ordering in the source: the word may not appear in the expression that answers.
    const source = readFileSync(join(import.meta.dir, "storage-backend.ts"), "utf8");
    const answer = source.slice(
      source.indexOf("const backend: ServerStorageBackend ="),
      source.indexOf("const present ="),
    );
    expect(answer).toContain("SERVER_DATABASE_URL_SETTING");
    expect(answer).not.toMatch(/RETIRED_SERVER_MODE_SETTINGS|RETIRED_VALUE_BACKENDS/);
    expect(source).not.toMatch(/\bresolveEmailsMode/);
    expect(source).not.toMatch(/\bisSelfHostedMode\b/);
  });

  it("leaves no server module reading the retired word to choose a store", () => {
    // A POSITIVE CONTROL for the absence claim: the same scan run against a fixture that DOES
    // contain the offending read must find it, or this assertion proves nothing. A one-character
    // typo in the pattern would otherwise pass over every file in silence.
    const offending = 'const mode = resolveEmailsModeSelection().mode;\nif (mode === "self_hosted") {}';
    const scan = (text: string): boolean =>
      /resolveEmailsMode(?:Selection)?\(/.test(text) || /\bgetEmailsMode\(/.test(text);
    expect(scan(offending)).toBe(true);

    for (const relative of [
      "src/server/index.ts",
      "src/server/bind-options.ts",
      "src/server/self-hosted/env.ts",
      "src/server/self-hosted/migrate.ts",
    ]) {
      expect(scan(readFileSync(join(root, relative), "utf8")), `${relative} still reads the word`)
        .toBe(false);
    }
  });
});
