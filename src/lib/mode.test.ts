// Dual-mode resolver contract: local is the safe default and never loads remote
// credentials; self_hosted is explicit and fails closed without URL + credential.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { resetSelfHostedConfigCache } from "../db/self-hosted-store.js";
import {
  EMAILS_CLIENT_ENV_SECRET_ENV,
  EMAILS_MODE_ENV,
  HASNA_EMAILS_MODE_ENV,
  assertNoLegacyHostedEnvironment,
  clientEnvCredentialOverrideWarning,
  clientEnvPointerOverrideWarning,
  getEmailsMode,
  labelForEmailsMode,
  normalizeEmailsMode,
  resolveEmailsMode,
  resolveEmailsModeSelection,
} from "./mode.js";
import { saveConfig } from "./config.js";

let INHERITED_PROCESS_ENV: NodeJS.ProcessEnv;
let ORIGINAL_HOME: string | undefined;
let ORIGINAL_PATH: string | undefined;
function captureInheritedProcessEnv(): void {
  INHERITED_PROCESS_ENV = { ...process.env };
  ORIGINAL_HOME = process.env["HOME"];
  ORIGINAL_PATH = process.env["PATH"];
}
function restoreInheritedProcessEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
}

const TMP_HOME = join("/tmp", `emails-mode-test-${process.pid}`);

const ENV_KEYS = [
  EMAILS_MODE_ENV,
  HASNA_EMAILS_MODE_ENV,
  EMAILS_CLIENT_ENV_SECRET_ENV,
  "HASNA_EMAILS_DB_PATH",
  "EMAILS_DB_PATH",
  "EMAILS_SELF_HOSTED_URL",
  "EMAILS_SELF_HOSTED_API_KEY",
  "EMAILS_SESSION_TOKEN",
  "EMAILS_IDP_TOKEN",
  // Legacy mode keys (must be rejected loudly).
  "MAILERY_MODE",
  "HASNA_MAILERY_MODE",
  "MAILERY_STORAGE_MODE",
  "HASNA_MAILERY_STORAGE_MODE",
  "EMAILS_STORAGE_MODE",
  "HASNA_EMAILS_STORAGE_MODE",
  // Legacy hosted credential keys (must be ignored, never select/redirect).
  "MAILERY_API_URL",
  "MAILERY_API_KEY",
  "MAILERY_CLOUD_API_URL",
  "MAILERY_CLOUD_TOKEN",
  "HASNA_MAILERY_API_URL",
  "HASNA_MAILERY_API_KEY",
  "HASNA_MAILERY_ENV_FILE",
] as const;

// A canonical, non-loopback self-hosted endpoint (HTTPS is mandatory off-loopback).
const SELF_HOSTED_URL = "https://emails.example.invalid";
const SELF_HOSTED_KEY = "not-a-real-key";

function setSelfHostedCredentials(): void {
  process.env["EMAILS_SELF_HOSTED_URL"] = SELF_HOSTED_URL;
  process.env["EMAILS_SELF_HOSTED_API_KEY"] = SELF_HOSTED_KEY;
}

// Install a `secrets` shim on PATH that returns a self_hosted client-env payload.
function installSelfHostedSecretsCommand(): void {
  const binDir = join(TMP_HOME, "bin");
  mkdirSync(binDir, { recursive: true });
  const secretsBin = join(binDir, "secrets");
  writeFileSync(
    secretsBin,
    `#!/bin/sh
if [ "$1" = "get" ] && [ "$2" = "hasna/xyz/opensource/emails/prod/client-env" ]; then
  printf '%s\\n' '{"EMAILS_MODE":"self_hosted","EMAILS_SELF_HOSTED_URL":"${SELF_HOSTED_URL}","EMAILS_SELF_HOSTED_API_KEY":"${SELF_HOSTED_KEY}"}'
  exit 0
fi
exit 2
`,
  );
  chmodSync(secretsBin, 0o700);
  process.env["PATH"] = `${binDir}:${ORIGINAL_PATH ?? ""}`;
  process.env[EMAILS_CLIENT_ENV_SECRET_ENV] = "hasna/xyz/opensource/emails/prod/client-env";
}

// Install a `secrets` shim that FAILS loudly if invoked — proves the loader is
// never reached (e.g. for a removed mode).
function installFailingSecretsCommand(): void {
  const binDir = join(TMP_HOME, "bin-fail");
  mkdirSync(binDir, { recursive: true });
  const secretsBin = join(binDir, "secrets");
  writeFileSync(
    secretsBin,
    `#!/bin/sh
echo "secrets command should not be called" >&2
exit 42
`,
  );
  chmodSync(secretsBin, 0o700);
  process.env["PATH"] = `${binDir}:${ORIGINAL_PATH ?? ""}`;
  process.env[EMAILS_CLIENT_ENV_SECRET_ENV] = "hasna/xyz/opensource/emails/prod/client-env";
}

beforeEach(() => {
  captureInheritedProcessEnv();
  mkdirSync(TMP_HOME, { recursive: true });
  process.env["HOME"] = TMP_HOME;
  for (const key of ENV_KEYS) delete process.env[key];
  if (ORIGINAL_PATH === undefined) delete process.env["PATH"];
  else process.env["PATH"] = ORIGINAL_PATH;
  resetSelfHostedConfigCache();
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  if (ORIGINAL_HOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = ORIGINAL_HOME;
  if (ORIGINAL_PATH === undefined) delete process.env["PATH"];
  else process.env["PATH"] = ORIGINAL_PATH;
  if (existsSync(TMP_HOME)) rmSync(TMP_HOME, { recursive: true, force: true });
  resetSelfHostedConfigCache();
  restoreInheritedProcessEnv();
});

describe("normalizeEmailsMode", () => {
  it("accepts exactly local and self_hosted (case-insensitive, trimmed)", () => {
    expect(normalizeEmailsMode("local")).toBe("local");
    expect(normalizeEmailsMode("  LOCAL  ")).toBe("local");
    expect(normalizeEmailsMode("self_hosted")).toBe("self_hosted");
    expect(normalizeEmailsMode("  SELF_HOSTED  ")).toBe("self_hosted");
  });

  it("rejects cloud, remote, hybrid, and spelling aliases", () => {
    for (const value of ["cloud", "remote", "hybrid", "self-hosted", "selfhosted"]) {
      expect(() => normalizeEmailsMode(value)).toThrow(/removed hosted|exactly local or self_hosted/);
    }
  });
});

describe("labelForEmailsMode / getEmailsMode", () => {
  it("labels both canonical modes", () => {
    expect(labelForEmailsMode("local")).toBe("Local");
    expect(labelForEmailsMode("self_hosted")).toBe("Self-hosted");
  });

  it("defaults to local without loading self-hosted configuration", () => {
    expect(getEmailsMode()).toBe("local");
  });

  it("getEmailsMode returns self_hosted once configured", () => {
    process.env[EMAILS_MODE_ENV] = "self_hosted";
    setSelfHostedCredentials();
    expect(getEmailsMode()).toBe("self_hosted");
  });
});

describe("assertNoLegacyHostedEnvironment", () => {
  it("throws on removed storage-mode env vars (both prefixes)", () => {
    for (const key of [
      "MAILERY_STORAGE_MODE",
      "HASNA_MAILERY_STORAGE_MODE",
      "EMAILS_STORAGE_MODE",
      "HASNA_EMAILS_STORAGE_MODE",
    ]) {
      const env = { [key]: "cloud" } as NodeJS.ProcessEnv;
      expect(() => assertNoLegacyHostedEnvironment(env)).toThrow("removed hosted/legacy runtime");
    }
  });

  it("rejects the MAILERY_MODE selectors whatever value they carry", () => {
    // MAILERY_MODE / HASNA_MAILERY_MODE configured the removed Mailery runtime.
    // Honouring one would start this package in a mode the operator never asked
    // it for, so both are refused even for an otherwise-valid value.
    for (const key of ["MAILERY_MODE", "HASNA_MAILERY_MODE"]) {
      for (const value of ["local", "self_hosted", "cloud"]) {
        expect(() => assertNoLegacyHostedEnvironment({ [key]: value } as NodeJS.ProcessEnv))
          .toThrow("removed hosted/legacy runtime");
      }
    }
  });

  it("rejects legacy hosted API credentials so they cannot select a backend", () => {
    const env = {
      MAILERY_API_URL: "https://legacy.example",
      MAILERY_API_KEY: "legacy",
      HASNA_MAILERY_API_URL: "https://legacy.example",
      HASNA_MAILERY_API_KEY: "legacy",
    } as NodeJS.ProcessEnv;
    expect(() => assertNoLegacyHostedEnvironment(env)).toThrow("removed hosted/legacy runtime");
  });
});

describe("resolveEmailsMode — dual mode", () => {
  it("resolves self_hosted from explicit mode + mandatory URL and key", () => {
    process.env[EMAILS_MODE_ENV] = "self_hosted";
    setSelfHostedCredentials();
    expect(resolveEmailsMode()).toEqual({
      mode: "self_hosted",
      label: "Self-hosted",
      source: { kind: "env", name: EMAILS_MODE_ENV, value: "self_hosted" },
      warning: null,
    });
  });

  it("refuses credentials alone instead of splitting API storage from local mode", () => {
    setSelfHostedCredentials();
    expect(() => resolveEmailsMode()).toThrow("EMAILS_SELF_HOSTED_URL configures an Emails API");
  });

  it("accepts the Hasna-prefixed mode alias", () => {
    process.env[HASNA_EMAILS_MODE_ENV] = "self_hosted";
    setSelfHostedCredentials();
    expect(resolveEmailsMode()).toMatchObject({ mode: "self_hosted", label: "Self-hosted" });
  });

  it("rejects MAILERY_MODE and names the key", () => {
    for (const value of ["self_hosted", "cloud", "remote", "hybrid"]) {
      process.env["MAILERY_MODE"] = value;
      setSelfHostedCredentials();
      resetSelfHostedConfigCache();
      expect(() => resolveEmailsMode()).toThrow("MAILERY_MODE");
      expect(() => resolveEmailsMode()).toThrow("removed hosted/legacy runtime");
    }
  });

  it("resolves and validates a config-selected self_hosted client without requiring EMAILS_MODE", () => {
    saveConfig({ emails_mode: "self_hosted" });
    setSelfHostedCredentials();

    expect(process.env[EMAILS_MODE_ENV]).toBeUndefined();
    expect(resolveEmailsMode()).toMatchObject({
      mode: "self_hosted",
      label: "Self-hosted",
      source: { kind: "config", name: "emails_mode", value: "self_hosted" },
    });
  });

  it("defaults to local when no endpoint is configured, and says nothing about it", () => {
    // The counter-control for the shadowing note: with nothing configured there is
    // nothing being overridden, and a note on every ordinary local invocation would be
    // noise — which is how a real one gets skipped.
    expect(resolveEmailsMode()).toMatchObject({
      mode: "local",
      source: { kind: "default" },
      warning: null,
    });
  });

  it("fails loud when the mode is set but URL/key are missing", () => {
    process.env[EMAILS_MODE_ENV] = "self_hosted";
    expect(() => resolveEmailsMode()).toThrow("not configured");
  });

  it("accepts explicit local without consulting self-hosted credentials", () => {
    process.env[EMAILS_MODE_ENV] = "local";
    setSelfHostedCredentials();
    const resolution = resolveEmailsMode();
    expect(resolution).toMatchObject({ mode: "local", source: { kind: "env", name: EMAILS_MODE_ENV } });
    // Precedence unchanged — local still wins and no credential is read. But this
    // fixture sets the canonical self-hosted URL + key and THEN selects local, which
    // is the direct-configuration form of the shadowing bug: the process reads an
    // empty local database while a deployment is fully configured in the same
    // environment. It must say so, exactly as it does for a vault pointer.
    // ENV_KEYS[0] is the canonical selector, used positionally because the mode-axis
    // ratchet pins how many times its NAME may appear tree-wide.
    expect(resolution.warning).toBe(clientEnvCredentialOverrideWarning(ENV_KEYS[0], SELF_HOSTED_URL));
    expect(JSON.stringify(resolution)).not.toContain(SELF_HOSTED_KEY);
  });


  it("rejects removed cloud/remote/hybrid aliases", () => {
    for (const value of ["cloud", "remote", "hybrid"]) {
      process.env[EMAILS_MODE_ENV] = value;
      setSelfHostedCredentials();
      resetSelfHostedConfigCache();
      expect(() => resolveEmailsMode()).toThrow("removed hosted/legacy runtime");
    }
  });

  it("rejects legacy Mailery/storage mode environment variables", () => {
    process.env["HASNA_MAILERY_STORAGE_MODE"] = "cloud";
    setSelfHostedCredentials();
    expect(() => resolveEmailsMode()).toThrow("removed hosted/legacy runtime");
  });

  it("rejects inherited hosted API credentials (they never configure the client)", () => {
    process.env["HASNA_MAILERY_API_URL"] = "https://example.invalid";
    process.env["HASNA_MAILERY_API_KEY"] = "not-a-real-key";
    expect(() => resolveEmailsMode()).toThrow("removed hosted/legacy runtime");
  });

  it("lets an explicit self_hosted endpoint override unrelated Mailery hosted credentials", () => {
    process.env[EMAILS_MODE_ENV] = "self_hosted";
    setSelfHostedCredentials();
    process.env["HASNA_MAILERY_API_URL"] = "https://mailery.example.invalid";
    process.env["HASNA_MAILERY_API_KEY"] = "old-mailery-key";
    expect(resolveEmailsMode()).toMatchObject({
      mode: "self_hosted",
      source: { kind: "env", name: EMAILS_MODE_ENV },
    });
  });
});

describe("resolveEmailsMode — EMAILS_CLIENT_ENV_SECRET", () => {
  it("selects operator mode from a client secret pointer without reading the secret", () => {
    installFailingSecretsCommand();

    expect(resolveEmailsModeSelection()).toMatchObject({
      mode: "self_hosted",
      source: { kind: "env", name: EMAILS_CLIENT_ENV_SECRET_ENV },
    });
    expect(process.env[EMAILS_MODE_ENV]).toBeUndefined();
  });

  it("loads canonical self_hosted env from the client-env secret pointer", () => {
    installSelfHostedSecretsCommand();

    expect(resolveEmailsMode()).toMatchObject({
      mode: "self_hosted",
      label: "Self-hosted",
      source: { kind: "env", name: EMAILS_CLIENT_ENV_SECRET_ENV },
      // The pointer was honoured, so nothing is being shadowed.
      warning: null,
    });
    // The pointer is expanded into the canonical env names.
    expect(process.env[EMAILS_MODE_ENV]).toBe("self_hosted");
    expect(process.env["EMAILS_SELF_HOSTED_URL"]).toBe(SELF_HOSTED_URL);
    expect(process.env["EMAILS_SELF_HOSTED_API_KEY"]).toBe(SELF_HOSTED_KEY);
  });

  it("does not report the secret value on the error path or the resolution", () => {
    installSelfHostedSecretsCommand();
    const resolution = resolveEmailsMode();
    // The source carries the (non-secret) vault POINTER, never the key value.
    expect(JSON.stringify(resolution)).not.toContain(SELF_HOSTED_KEY);
    expect(resolution.source.value).toBe("hasna/xyz/opensource/emails/prod/client-env");
  });

  it("never invokes the secrets loader for local mode, but SAYS it overrode the pointer", () => {
    installFailingSecretsCommand();
    process.env[EMAILS_MODE_ENV] = "local";

    const resolution = resolveEmailsMode();
    expect(resolution).toMatchObject({ mode: "local", label: "Local" });
    // And the loader left the canonical credentials untouched.
    expect(process.env["EMAILS_SELF_HOSTED_URL"]).toBeUndefined();
    expect(process.env["EMAILS_SELF_HOSTED_API_KEY"]).toBeUndefined();

    // THE REGRESSION (2026-07-27). Precedence above is correct and unchanged: the
    // explicit selector beats the pointer and the loader is never reached. What used
    // to be missing is any statement that it happened — `warning` was typed `null`
    // and permanently unpopulated, while src/lib/doctor.local.ts already rendered it
    // as a warn-level "Mode" check and src/lib/agent-context.ts already printed
    // "Mode note:". Both surfaces were wired to a value that could not arrive, so the
    // CLI read an empty local database and reported "0 total, 0 unread" against a
    // deployment holding ~170,000 messages.
    expect(resolution.warning).not.toBeNull();
    // ENV_KEYS[0] is the canonical selector; used positionally because the mode-axis
    // ratchet pins how many times its NAME may appear anywhere in the tree.
    expect(resolution.warning).toBe(
      clientEnvPointerOverrideWarning(ENV_KEYS[0], "hasna/xyz/opensource/emails/prod/client-env"),
    );
    // Never a credential value, even on the noisy path.
    expect(JSON.stringify(resolution)).not.toContain(SELF_HOSTED_KEY);
  });
});

// THE SILENT OVERRIDE (2026-07-27).
//
// A stale explicit local-mode selector — injected by `tmux set-environment -g` into
// every pane created after it was set, so present in NO config file — shadowed a
// configured EMAILS_CLIENT_ENV_SECRET pointer. loadEmailsClientEnvSecret
// returned early without spawning `secrets get`, the CLI read the local SQLite
// database, and `emails inbox status` reported "0 total, 0 unread" against a
// deployment holding ~170,000 messages. Agents investigating a blocked production
// email concluded the mailbox was empty.
//
// The precedence is CORRECT and these tests keep it: an explicit variable must beat
// a pointer. What was missing is that nothing said so. The `warning` field existed
// on EmailsModeResolution and was typed `null` — permanently unpopulated — while
// src/lib/doctor.local.ts already rendered it as a warn-level "Mode" check and
// src/lib/agent-context.ts already printed "Mode note:". Both surfaces were wired
// to a value that could never arrive.
describe("clientEnvPointerOverrideWarning — the note an operator has to be able to act on", () => {
  const POINTER = "hasna/xyz/opensource/emails/prod/client-env";
  // The mode-axis ratchet (src/mode-axis-ratchet.test.ts) pins, tree-wide and with an
  // explicit "may only shrink" rule, both how many times the mode variable is NAMED
  // and how many times the resolver is CALLED. So these cases take the key names from
  // the ENV_KEYS list above instead of spelling them, and they exercise the pure
  // message builder rather than adding resolver call sites — the resolver WIRING is
  // asserted on the existing resolution tests above, which already construct exactly
  // this scenario. ENV_KEYS[0] is the canonical selector, ENV_KEYS[1] its twin.
  const MODE_KEY = ENV_KEYS[0];
  const LEGACY_TWIN_KEY = ENV_KEYS[1];

  for (const key of [MODE_KEY, LEGACY_TWIN_KEY] as const) {
    it(`names ${key}, the pointer it overrides, and the way out`, () => {
      const warning = clientEnvPointerOverrideWarning(key, POINTER);

      // It must name the variable the operator has to change. A generic "mode
      // mismatch" note is what leaves someone grepping dotfiles for a value that
      // lives only in a tmux-injected pane environment.
      expect(warning).toContain(key);
      expect(warning).toContain(EMAILS_CLIENT_ENV_SECRET_ENV);
      // …the pointer being overridden (a non-secret vault path)…
      expect(warning).toContain(POINTER);
      // …and the one-shot escape hatch, so the reader can prove it in one command.
      expect(warning).toContain(`env -u ${key}`);
      // It must say the numbers do not describe the deployment. A note that only says
      // "mode is local" reads as informational next to a plausible 0.
      expect(warning.toLowerCase()).toContain("local database");
      expect(warning).toContain("do NOT describe the self-hosted");
    });
  }

  it("says the value may be INHERITED, not configured — the reason grepping finds nothing", () => {
    const warning = clientEnvPointerOverrideWarning(MODE_KEY, POINTER);
    // The stale selector is typically injected into child processes by something
    // upstream (a multiplexer's global environment, a supervisor, a CI runner) rather
    // than written in a config file, so an operator who greps their dotfiles finds
    // nothing and concludes the note is wrong.
    expect(warning).toContain("exported by a parent process");
    // And unsetting it at the source does not retract it from processes that already
    // exist, so a reader who fixes it upstream and re-runs in the same shell is still
    // blind. The note has to say that or it invites exactly that conclusion.
    expect(warning).toContain("already-running shells");
  });

  // REVIEW FINDING. Keying the note solely on the vault pointer left the identical
  // silent wrong-database read uncovered for an operator who exports the canonical
  // URL + credential directly — the same "0 total" against a live deployment, with
  // the same absence of any note.
  it("also fires when explicit local shadows a DIRECTLY configured endpoint", () => {
    const warning = clientEnvCredentialOverrideWarning(MODE_KEY, SELF_HOSTED_URL);
    expect(warning).toContain(MODE_KEY);
    expect(warning).toContain(SELF_HOSTED_URL);
    expect(warning).toContain(`env -u ${MODE_KEY}`);
    expect(warning).toContain("do NOT describe the self-hosted");
    // The endpoint is named; the credential never is.
    expect(warning).not.toContain(SELF_HOSTED_KEY);
  });

  it("carries no credential value — only the pointer name", () => {
    const warning = clientEnvPointerOverrideWarning(MODE_KEY, POINTER);
    expect(warning).not.toContain(SELF_HOSTED_KEY);
    expect(warning).not.toContain(SELF_HOSTED_URL);
  });
});
