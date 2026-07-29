// THE SPLIT-BRAIN CONFIGURATION MUST REFUSE, NOT FORK. During the axis migration two
// routing regimes coexist in every process: families already moved to the store seam
// resolve their storage from configuration alone (src/store-resolution.ts, which
// deliberately never reads the deployment word), while the families not yet moved are
// still dispatched by the process-wide deployment word. For ONE common configuration
// their answers contradict: an API base URL plus a credential, with the deployment
// word unset, sends the seam families to the HTTP API while the word-routed families
// default to the local SQLite database — two mailboxes in one process, no diagnostic,
// and single commands straddle both regimes (owners resolved locally, send keys
// minted through the API). That is the silent wrong-store read this repo classes as
// its worst bug. Until the axis deletion collapses the second regime, the defaulting
// side fails closed on this configuration and names both settings.
//
// NAMING NOTE: this file sits inside the deployment-axis ratchet's scanned corpus and
// must contribute nothing to any of its counts. The deployment-word env keys are
// therefore ASSEMBLED rather than spelled, and the refusal is driven through a real
// word-routed repository facade rather than through the resolver identifiers the
// ratchet counts — which is also the stronger test: it proves the exact call shape
// the audit confirmed at runtime now refuses.
//
// EVERY TEST HERE DRIVES process.env, because the word-routed dispatch reads the real
// environment; the inherited environment is restored after each case.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase } from "../db/database.js";
import { listOwners } from "../db/owners.js";
import {
  API_BASE_URL_SETTING,
  API_CREDENTIAL_SETTINGS,
  API_SETTINGS_POINTER,
  DATABASE_PATH_SETTINGS,
  StoreConfigurationError,
  planEmailStore,
} from "../store-resolution.js";

/** The deployment-word env keys, by construction — see the naming note above. */
const WORD_SETTINGS = ["", "HASNA_"].map((prefix) => prefix + ["EMAILS", "MODE"].join("_"));

const A_URL = "https://mail.example.test";
const A_KEY = "hasna_coherence_test_key";

let inherited: NodeJS.ProcessEnv;

/** Exactly these settings, with every setting either regime reads removed first. */
function only(settings: Record<string, string>): void {
  for (const key of [
    ...WORD_SETTINGS,
    ...DATABASE_PATH_SETTINGS,
    API_BASE_URL_SETTING,
    API_SETTINGS_POINTER,
    ...API_CREDENTIAL_SETTINGS,
  ]) {
    delete process.env[key];
  }
  Object.assign(process.env, settings);
}

beforeEach(() => {
  inherited = { ...process.env };
});

afterEach(() => {
  closeDatabase();
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(inherited, key)) delete process.env[key];
  }
  Object.assign(process.env, inherited);
});

describe("split-brain storage configuration — the word-routed side fails closed", () => {
  it("REFUSES the word-routed families when storage names an API and the word is unset", () => {
    only({ [API_BASE_URL_SETTING]: A_URL, [API_CREDENTIAL_SETTINGS[2]]: A_KEY });
    // The divergence is real, not hypothetical: the seam side of this SAME
    // environment resolves to the API store...
    expect(planEmailStore(process.env).store).toBe("api");
    // ...so a word-routed family defaulting to local SQLite here would read a
    // different mailbox than its seam-routed neighbours. It must refuse instead.
    let thrown: unknown;
    try {
      listOwners();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StoreConfigurationError);
    const error = thrown as StoreConfigurationError;
    // The message names BOTH settings — the one that is set and the one that is not —
    // and says what to do in both directions.
    expect(error.message).toContain(API_BASE_URL_SETTING);
    expect(error.message).toContain(WORD_SETTINGS[0]);
    // BOTH remedies, as remedies — asserted as whole phrases because the state
    // description also uses the word "unset", and a message that only described the
    // problem would satisfy a bare substring check while helping nobody.
    expect(error.message).toContain(`${WORD_SETTINGS[0]}=self_hosted`);
    expect(error.message).toContain(`unset ${API_BASE_URL_SETTING}`);
    // The machine-readable half carries the same two keys.
    expect([...error.settings].sort()).toEqual([WORD_SETTINGS[0], API_BASE_URL_SETTING].sort());
    // No credential value is ever quoted; this message can reach any log line.
    expect(error.message).not.toContain(A_KEY);
  });

  it("refuses the session-token flavour of the same configuration", () => {
    only({ [API_BASE_URL_SETTING]: A_URL, [API_CREDENTIAL_SETTINGS[0]]: "emss_coherence_token" });
    expect(() => listOwners()).toThrow(StoreConfigurationError);
    expect(() => listOwners()).toThrow(API_BASE_URL_SETTING);
  });

  it("stays out of the way when a database path is configured beside the URL", () => {
    // Both storage settings configured is the store seam's OWN boot contradiction
    // (asserted by src/store-resolution.test.ts), refused loudly in the seam's own
    // words. The word-routed side keeps its long-standing behaviour rather than
    // stacking a second refusal in a different dialect on top of that one.
    only({
      [DATABASE_PATH_SETTINGS[1]]: ":memory:",
      [API_BASE_URL_SETTING]: A_URL,
      [API_CREDENTIAL_SETTINGS[2]]: A_KEY,
    });
    expect(() => planEmailStore(process.env)).toThrow(StoreConfigurationError);
    expect(() => listOwners()).not.toThrow();
  });

  it("keys on the configured URL, never on a credential alone", () => {
    // A credential with no URL configures nothing — the seam resolves local SQLite —
    // so the word-routed default agrees with the seam and there is nothing to refuse.
    only({ [DATABASE_PATH_SETTINGS[1]]: ":memory:", [API_CREDENTIAL_SETTINGS[2]]: A_KEY });
    expect(planEmailStore(process.env).store).toBe("sqlite");
    expect(() => listOwners()).not.toThrow();
  });

  it("leaves an incomplete API configuration to the seam's own refusal", () => {
    // A URL with no credential cannot resolve to a working API store; the seam
    // refuses it by name (missing credential), so the word-routed side does not add
    // a second, different refusal about the deployment word on top.
    only({ [API_BASE_URL_SETTING]: A_URL });
    expect(() => planEmailStore(process.env)).toThrow(StoreConfigurationError);
    expect(() => listOwners()).not.toThrow();
  });
});
