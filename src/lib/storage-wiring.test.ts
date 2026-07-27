// The storage-configuration read, tested on its own.
//
// WHY IT HAS ITS OWN SUITE. It was extracted from `src/lib/status-facts.ts` so a second caller
// could share one definition site, and a mutation run then showed the cost of leaving it
// untested where it landed: inverting its `:memory:` discrimination survived the forwarding
// suite entirely, because BOTH shapes of local storage are equally acceptable to that pipeline.
// It was killed only by the status suite, several layers away from the line at fault. A helper
// with two callers that disagree about which of its answers matter needs cases of its own.
//
// `HOME` IS REDIRECTED IN EVERY CASE. The default-path branch resolves — and CREATES — a data
// directory, so a case about configuration must not be able to touch a developer's real mailbox.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  API_BASE_URL_SETTING,
  API_CREDENTIAL_SETTINGS,
  API_SETTINGS_POINTER,
  DATABASE_PATH_SETTINGS,
  StoreConfigurationError,
} from "../store-resolution.js";
import { readStorageWiring, storeErrorMessage } from "./storage-wiring.js";

let INHERITED_PROCESS_ENV: NodeJS.ProcessEnv;
let home: string;

function clearStoreSettings(env: NodeJS.ProcessEnv): void {
  for (const setting of [API_BASE_URL_SETTING, API_SETTINGS_POINTER, ...API_CREDENTIAL_SETTINGS]) {
    delete env[setting];
  }
  for (const setting of DATABASE_PATH_SETTINGS) delete env[setting];
}

beforeEach(() => {
  INHERITED_PROCESS_ENV = { ...process.env };
  home = mkdtempSync(join(tmpdir(), "storage-wiring-home-"));
  process.env["HOME"] = home;
  clearStoreSettings(process.env);
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
  rmSync(home, { recursive: true, force: true });
});

/**
 * Configure through the AMBIENT environment and hand the same object in.
 *
 * NOT a convenience. See the asymmetry pinned at the bottom of this file: the `env` argument
 * selects the STORE (through `planEmailStore`) but the PATH comes from `getDatabasePath()`, which
 * reads `process.env` directly and takes no argument. Both shipped callers pass `process.env`, so
 * the two halves agree in production — and a test that configured only the argument would be
 * measuring a configuration the function never sees.
 */
function configure(settings: Record<string, string>): NodeJS.ProcessEnv {
  clearStoreSettings(process.env);
  for (const [key, value] of Object.entries(settings)) process.env[key] = value;
  return process.env;
}

describe("readStorageWiring", () => {
  it("reports an on-disk database as a FILE, with the path the rows are actually in", () => {
    const file = join(home, "mail.db");
    expect(readStorageWiring(configure({ [DATABASE_PATH_SETTINGS[1]]: file }))).toEqual({
      kind: "database_file",
      path: file,
    });
  });

  it("reports an in-memory database as its OWN kind, not as a file", () => {
    // The distinction the forwarding pipeline does not care about and the status payload does:
    // "in memory" and "at this path" are different answers, and collapsing them makes a status
    // report claim a data directory that does not exist.
    expect(readStorageWiring(configure({ [DATABASE_PATH_SETTINGS[1]]: ":memory:" }))).toEqual({
      kind: "database_in_memory",
    });
  });

  it("reports the DEFAULT database as a file when nothing names one", () => {
    const wiring = readStorageWiring(configure({}));
    expect(wiring.kind).toBe("database_file");
    expect(wiring.kind === "database_file" && wiring.path.startsWith(home)).toBe(true);
  });

  it("reports API storage, and carries NO path and NO credential", () => {
    const wiring = readStorageWiring(configure({
      [API_BASE_URL_SETTING]: "https://mail.example.test",
      [API_CREDENTIAL_SETTINGS[0]]: "not-a-real-credential",
    }));
    expect(wiring).toEqual({ kind: "api" });
    // A wiring value is the object most likely to reach a log line. Asserted by SHAPE rather than
    // by scanning a string, so a future field cannot smuggle one in.
    expect(Object.keys(wiring)).toEqual(["kind"]);
  });

  it("reports a CONTRADICTORY configuration as unresolved, naming both settings", () => {
    const wiring = readStorageWiring(configure({
      [API_BASE_URL_SETTING]: "https://mail.example.test",
      [API_CREDENTIAL_SETTINGS[0]]: "not-a-real-credential",
      [DATABASE_PATH_SETTINGS[1]]: ":memory:",
    }));
    expect(wiring.kind).toBe("unresolved");
    const message = wiring.kind === "unresolved" ? wiring.message : "";
    expect(message).toContain(API_BASE_URL_SETTING);
    expect(message).toContain(DATABASE_PATH_SETTINGS[1]);
  });

  it("REPORTS a configuration failure rather than throwing it", () => {
    // The property both callers depend on and neither can recover from if it breaks: `emails
    // status` must be able to report that its own storage is broken, and the forwarding pipeline
    // must be able to name the fault inside its own refusal.
    const env = configure({
      [API_BASE_URL_SETTING]: "not-a-url",
      [API_CREDENTIAL_SETTINGS[0]]: "not-a-real-credential",
    });
    expect(() => readStorageWiring(env)).not.toThrow();
    expect(readStorageWiring(env).kind).toBe("unresolved");
  });

  it("reports a REFUSED data directory as unresolved too, not as a file", () => {
    // The second, distinct reason this arm is reached: the configuration is the unambiguous
    // DEFAULT and the directory itself is refused. `getDatabasePath()` rejects a symlinked data
    // directory, and a caller that treated this as a `database_file` would go on to open it.
    symlinkSync(tmpdir(), join(home, ".hasna"));
    const wiring = readStorageWiring(configure({}));
    expect(wiring.kind).toBe("unresolved");
    expect(wiring.kind === "unresolved" && wiring.message.length > 0).toBe(true);
  });

  it("PINNED ASYMMETRY: the argument selects the STORE, the ambient environment resolves the PATH", () => {
    // A PRE-EXISTING INCONSISTENCY IN THIS FUNCTION, carried over verbatim from
    // `src/lib/status-facts.ts` and pinned here rather than fixed, because fixing it means giving
    // `getDatabasePath()` an environment parameter and that file has an unrelated change in
    // flight. It is HARMLESS TODAY only because both shipped callers pass `process.env`.
    //
    // The half that honours the argument: `planEmailStore(env)`. The half that does not:
    // `getDatabasePath()`, which reads `process.env` directly and takes no argument. So an
    // argument that names a database path is used to decide THAT there is a local database and
    // then ignored when reporting WHICH one — the answer below is the ambient default, not the
    // path in the argument.
    //
    // Asserted so that closing the gap is a deliberate, visible change rather than a silent one.
    clearStoreSettings(process.env);
    const detached = readStorageWiring({ [DATABASE_PATH_SETTINGS[1]]: join(home, "named-in-the-argument.db") });
    expect(detached.kind).toBe("database_file");
    expect(
      detached.kind === "database_file" && detached.path.endsWith("named-in-the-argument.db"),
      "if this is now true, the asymmetry has been closed and this case should assert the fix",
    ).toBe(false);
    expect(detached.kind === "database_file" && detached.path.startsWith(home)).toBe(true);
  });
});

describe("storeErrorMessage", () => {
  it("appends the settings a store-configuration failure refused on", () => {
    const error = new StoreConfigurationError("two settings disagree", ["A_SETTING", "B_SETTING"]);
    expect(storeErrorMessage(error)).toBe("two settings disagree (A_SETTING, B_SETTING)");
  });

  it("adds no parenthetical for an ordinary error", () => {
    expect(storeErrorMessage(new Error("plain"))).toBe("plain");
  });

  it("stringifies a thrown non-error rather than reporting nothing", () => {
    expect(storeErrorMessage("a bare string")).toBe("a bare string");
    expect(storeErrorMessage(undefined)).toBe("undefined");
  });
});
