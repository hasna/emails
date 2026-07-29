// `--json` SURFACES THAT DID NOT SPEAK JSON.
//
// Three lies, one family (tasks 15908bba, 7f2b4b6e, 1e8f179f):
//
//  * READ SURFACES AS PROSE. `template show/preview --json` and `sequence show
//    --json` never called `output()`; the patched console wrapped their prose
//    as {"output":["\nTemplate: ...","  ID: ..."]}, so a JSON consumer had to
//    screen-scrape subjects and steps out of display lines. `export <type>`
//    console.logged an already-JSON string, which the wrapper DOUBLE-encoded.
//    Mutation verbs (template add/remove, sequence create/enroll/step,
//    group create/members, contact suppress) returned prose only.
//
//  * SHAPE FLIP ON EMPTY. `inbox search --json` returned a bare array on any
//    hit but {"output":["No results for ..."]} on zero hits — a consumer
//    parsing for an array broke exactly when the answer was "none".
//
//  * ERRORS ON THE WRONG STREAM. `inbox read <missing> --json` wrote
//    {"error":...,"output":[]} to STDOUT via the exit hook, while sibling
//    not-found paths wrote {"error":{...}} to STDERR via handleError. Same
//    failure class, two streams, two shapes.
//
// WHY A SUBPROCESS: the error-path cases need `process.exit`; the rest reuse
// the same harness for uniformity. Environment scrubbed BY PREFIX (an operator
// shell may export this package's client configuration, and enumerating those
// keys here would add references the mode-axis ratchet counts).

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRUBBED_ENV_PREFIXES = ["EMAILS_", "HASNA_EMAILS_", "MAILERY_", "HASNA_MAILERY_"] as const;
const SCRUBBED_ENV_KEYS = [
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE",
  "RESEND_API_KEY",
] as const;

const tempDirs: string[] = [];

function localEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "emails-json-truth-"));
  tempDirs.push(dir);
  const homePath = join(dir, "home");
  mkdirSync(homePath, { recursive: true, mode: 0o700 });
  const base = { ...process.env };
  for (const key of Object.keys(base)) {
    if (SCRUBBED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) delete base[key];
  }
  for (const key of SCRUBBED_ENV_KEYS) delete base[key];
  return { ...base, EMAILS_DB_PATH: join(dir, "emails.db"), HOME: homePath, NO_COLOR: "1" };
}

interface CliRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: NodeJS.ProcessEnv): CliRun {
  const result = Bun.spawnSync({
    cmd: ["bun", "src/cli/index.tsx", ...args],
    cwd: process.cwd(),
    env,
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

/** Parse stdout as ONE JSON document and reject the console-wrapper shape. */
function structured(run: CliRun, what: string): unknown {
  expect(run.exitCode, `${what} failed: ${run.stderr}\n${run.stdout}`).toBe(0);
  let doc: unknown;
  try {
    doc = JSON.parse(run.stdout);
  } catch (error) {
    throw new Error(`${what} stdout is not a JSON document: ${String(error)}\n${run.stdout}`);
  }
  if (doc && typeof doc === "object" && !Array.isArray(doc) && "output" in (doc as Record<string, unknown>)) {
    throw new Error(`${what} emitted the prose wrapper, not structured data: ${run.stdout.slice(0, 300)}`);
  }
  return doc;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("template/sequence read surfaces are structured under --json", () => {
  it("template show --json returns the template row", () => {
    const env = localEnv();
    expect(runCli(["template", "add", "welcome", "--subject", "Hi {{name}}", "--text", "Body {{name}}"], env).exitCode).toBe(0);

    const doc = structured(runCli(["--json", "template", "show", "welcome"], env), "template show") as Record<string, unknown>;
    expect(doc["name"]).toBe("welcome");
    expect(doc["subject_template"]).toBe("Hi {{name}}");
    expect(doc["text_template"]).toBe("Body {{name}}");
  }, 120_000);

  it("template preview --json returns the rendered subject and body", () => {
    const env = localEnv();
    expect(runCli(["template", "add", "welcome", "--subject", "Hi {{name}}", "--text", "Body {{name}}"], env).exitCode).toBe(0);

    const doc = structured(
      runCli(["--json", "preview", "welcome", "--vars", '{"name":"Ada"}'], env),
      "template preview",
    ) as Record<string, unknown>;
    expect(doc["subject"]).toBe("Hi Ada");
    expect(String(doc["text"] ?? doc["body"] ?? "")).toContain("Ada");
  }, 120_000);

  it("sequence show --json returns the sequence with its steps", () => {
    const env = localEnv();
    expect(runCli(["template", "add", "step-one", "--subject", "s", "--text", "b"], env).exitCode).toBe(0);
    expect(runCli(["sequence", "create", "drip", "--description", "d"], env).exitCode).toBe(0);
    expect(runCli(["sequence", "step", "add", "drip", "--step", "1", "--delay", "24", "--template", "step-one"], env).exitCode).toBe(0);

    const doc = structured(runCli(["--json", "sequence", "show", "drip"], env), "sequence show") as Record<string, unknown>;
    expect((doc["sequence"] as Record<string, unknown>)["name"]).toBe("drip");
    const steps = doc["steps"] as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(1);
    expect(steps[0]?.["template_name"]).toBe("step-one");
  }, 120_000);

  it("export emails --json emits the export once, not a double-encoded string", () => {
    const env = localEnv();
    const doc = structured(runCli(["--json", "export", "emails"], env), "export emails");
    expect(Array.isArray(doc), `export must be the exported rows, got: ${JSON.stringify(doc).slice(0, 200)}`).toBe(true);
  }, 120_000);
});

describe("mutation verbs answer structured data under --json", () => {
  it("template add/remove, sequence create, group create, contact suppress", () => {
    const env = localEnv();

    const added = structured(runCli(["--json", "template", "add", "t", "--subject", "s", "--text", "b"], env), "template add") as Record<string, unknown>;
    expect(added["name"]).toBe("t");
    expect(typeof added["id"]).toBe("string");

    const removed = structured(runCli(["--json", "template", "remove", "t"], env), "template remove") as Record<string, unknown>;
    expect(removed["removed"]).toBe(true);

    const seq = structured(runCli(["--json", "sequence", "create", "s"], env), "sequence create") as Record<string, unknown>;
    expect(seq["name"]).toBe("s");

    const group = structured(runCli(["--json", "group", "create", "g"], env), "group create") as Record<string, unknown>;
    expect(group["name"]).toBe("g");

    const suppressed = structured(runCli(["--json", "contact", "suppress", "someone@example.com"], env), "contact suppress") as Record<string, unknown>;
    expect(suppressed["suppressed"]).toBe(true);
  }, 120_000);
});

describe("inbox search --json keeps one shape", () => {
  it("answers [] on zero hits, matching the non-empty array shape", () => {
    const env = localEnv();
    const run = runCli(["--json", "inbox", "search", "no-such-string-anywhere-zzz"], env);
    expect(run.exitCode, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual([]);
  }, 120_000);
});

describe("not-found errors converge on handleError", () => {
  for (const command of [
    ["inbox", "read", "zzzzzzzz"],
    ["inbox", "delete", "zzzzzzzz", "--yes"],
    ["inbox", "mark-read", "zzzzzzzz"],
  ] as const) {
    it(`\`${command.join(" ")}\` --json puts {"error":{...}} on stderr, nothing on stdout`, () => {
      const env = localEnv();
      const run = runCli(["--json", ...command], env);

      expect(run.exitCode).toBe(1);
      const failure = JSON.parse(run.stderr) as { error: { message: string } };
      // The local arm's id resolver phrases the miss as "Could not resolve ID";
      // the seam paths say "Email not found". Both are the same failure class —
      // what this suite pins is the STREAM and the SHAPE, not the wording.
      expect(failure.error.message).toMatch(/not found|could not resolve/i);
      expect(run.stdout.trim(), "the error document must not land on stdout").toBe("");
    }, 120_000);
  }
});
