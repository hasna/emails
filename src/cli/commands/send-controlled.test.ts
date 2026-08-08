import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { startV1Stub, type V1Stub } from "../../test-support/v1-stub.js";

type TerminalState =
  | "sent"
  | "idempotent_replay"
  | "in_progress"
  | "failed_retry_safe"
  | "failed_do_not_retry"
  | "rejected";

interface SafeReceipt {
  request_id: string;
  terminal_state: TerminalState;
  provider_result_state: string;
  message_id: string | null;
  idempotent_replay: boolean;
  receipt_path: string;
  started_at: string;
  completed_at: string;
}

const PRIVATE_SENTINELS = [
  "FROM_PRIVATE_SENTINEL",
  "TO_PRIVATE_SENTINEL",
  "CC_PRIVATE_SENTINEL",
  "BCC_PRIVATE_SENTINEL",
  "REPLY_PRIVATE_SENTINEL",
  "SUBJECT_PRIVATE_SENTINEL",
  "BODY_PRIVATE_SENTINEL",
  "HTML_PRIVATE_SENTINEL",
  "ATTACHMENT_PATH_PRIVATE_SENTINEL",
  "ATTACHMENT_CONTENT_PRIVATE_SENTINEL",
  "IDEMPOTENCY_PRIVATE_SENTINEL",
] as const;

const tempDirs: string[] = [];
let stub: V1Stub;

function cliEnv(): NodeJS.ProcessEnv {
  const { EMAILS_DB_PATH: _ignoredDbPath, ...environment } = process.env;
  return {
    ...environment,
    EMAILS_SELF_HOSTED_URL: stub.baseUrl,
    EMAILS_SELF_HOSTED_API_KEY: stub.apiKey,
    NO_COLOR: "1",
  };
}

function runCli(args: string[]) {
  return {
    args,
    result: Bun.spawnSync({
      cmd: ["bun", "src/cli/index.tsx", ...args],
      cwd: process.cwd(),
      env: cliEnv(),
      stdout: "pipe",
      stderr: "pipe",
    }),
  };
}

function spawnCli(args: string[]) {
  return {
    args,
    process: Bun.spawn({
      cmd: ["bun", "src/cli/index.tsx", ...args],
      cwd: process.cwd(),
      env: cliEnv(),
      stdout: "pipe",
      stderr: "pipe",
    }),
  };
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function assertNoPrivateSentinel(value: string): void {
  for (const sentinel of PRIVATE_SENTINELS) expect(value).not.toContain(sentinel);
}

function privateDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  chmodSync(dir, 0o700);
  return dir;
}

function writePrivateJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function fixture(overrides: Record<string, unknown> = {}) {
  const dir = privateDir("emails-controlled-send-");
  const bodyPath = join(dir, "body.txt");
  const attachmentPath = join(dir, "ATTACHMENT_PATH_PRIVATE_SENTINEL.txt");
  writeFileSync(bodyPath, "BODY_PRIVATE_SENTINEL", { mode: 0o600 });
  writeFileSync(attachmentPath, "ATTACHMENT_CONTENT_PRIVATE_SENTINEL", { mode: 0o600 });
  const requestId = "req_controlled_001";
  const descriptorPath = join(dir, "request.json");
  const descriptor = {
    request_id: requestId,
    idempotency_key: "IDEMPOTENCY_PRIVATE_SENTINEL",
    from: "FROM_PRIVATE_SENTINEL@sender.example",
    to: ["TO_PRIVATE_SENTINEL@recipient.example"],
    cc: ["CC_PRIVATE_SENTINEL@recipient.example"],
    bcc: ["BCC_PRIVATE_SENTINEL@recipient.example"],
    reply_to: "REPLY_PRIVATE_SENTINEL@sender.example",
    subject: "SUBJECT_PRIVATE_SENTINEL",
    text_file: bodyPath,
    html: "<p>HTML_PRIVATE_SENTINEL</p>",
    attachments: [{
      path: attachmentPath,
      filename: "synthetic.txt",
      content_type: "text/plain",
    }],
    ...overrides,
  };
  writePrivateJson(descriptorPath, descriptor);
  return {
    dir,
    requestId,
    descriptorPath,
    receiptPath: join(dir, "receipt.json"),
    secondReceiptPath: join(dir, "receipt-replay.json"),
    readbackReceiptPath: join(dir, "receipt-readback.json"),
    descriptor,
  };
}

function parseReceipt(path: string): SafeReceipt {
  return JSON.parse(readFileSync(path, "utf8")) as SafeReceipt;
}

function safeReceiptKeys(receipt: SafeReceipt): string[] {
  return Object.keys(receipt).sort();
}

beforeAll(async () => {
  stub = await startV1Stub();
});

afterAll(() => stub.stop());

beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});

afterEach(() => {
  stub.clearEnv();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("emails send-controlled", () => {
  it("sends once, replays the same key without a second provider call, and proves readback", async () => {
    const files = fixture();
    const first = runCli([
      "send-controlled", "apply",
      "--descriptor", files.descriptorPath,
      "--request-id", files.requestId,
      "--receipt", files.receiptPath,
    ]);
    const firstStdout = text(first.result.stdout);
    const firstStderr = text(first.result.stderr);
    expect(first.result.exitCode, firstStderr).toBe(0);
    expect(firstStdout).toBe(`${files.requestId} sent\n`);
    expect(firstStderr).toBe("");
    const firstReceipt = parseReceipt(files.receiptPath);
    expect(firstReceipt).toMatchObject({
      request_id: files.requestId,
      terminal_state: "sent",
      provider_result_state: "accepted_and_recorded",
      idempotent_replay: false,
      receipt_path: files.receiptPath,
    });
    expect(firstReceipt.message_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(safeReceiptKeys(firstReceipt)).toEqual([
      "completed_at",
      "idempotent_replay",
      "message_id",
      "provider_result_state",
      "receipt_path",
      "request_id",
      "started_at",
      "terminal_state",
    ]);

    const replay = runCli([
      "--json", "send-controlled", "apply",
      "--descriptor", files.descriptorPath,
      "--request-id", files.requestId,
      "--receipt", files.secondReceiptPath,
    ]);
    const replayStdout = text(replay.result.stdout);
    const replayStderr = text(replay.result.stderr);
    expect(replay.result.exitCode, replayStderr).toBe(0);
    expect(replayStderr).toBe("");
    const replayJson = JSON.parse(replayStdout) as SafeReceipt;
    expect(replayJson).toMatchObject({
      request_id: files.requestId,
      terminal_state: "idempotent_replay",
      provider_result_state: "accepted_and_recorded",
      idempotent_replay: true,
      receipt_path: files.secondReceiptPath,
      message_id: firstReceipt.message_id,
    });
    expect(parseReceipt(files.secondReceiptPath)).toEqual(replayJson);

    const readback = runCli([
      "send-controlled", "readback",
      "--descriptor", files.descriptorPath,
      "--request-id", files.requestId,
      "--receipt", files.readbackReceiptPath,
    ]);
    expect(readback.result.exitCode, text(readback.result.stderr)).toBe(0);
    expect(text(readback.result.stdout)).toBe(`${files.requestId} sent\n`);
    expect(parseReceipt(files.readbackReceiptPath)).toMatchObject({
      request_id: files.requestId,
      terminal_state: "sent",
      provider_result_state: "accepted_and_recorded",
      idempotent_replay: false,
      message_id: firstReceipt.message_id,
    });

    expect(await stub.sendStats()).toEqual({ providerCalls: 1 });
    expect(await stub.list("messages")).toHaveLength(1);

    const allPublicSurfaces = [
      first.args.join("\0"),
      firstStdout,
      firstStderr,
      JSON.stringify(firstReceipt),
      replay.args.join("\0"),
      replayStdout,
      replayStderr,
      JSON.stringify(replayJson),
      readback.args.join("\0"),
      text(readback.result.stdout),
      text(readback.result.stderr),
      readFileSync(files.readbackReceiptPath, "utf8"),
    ].join("\n");
    assertNoPrivateSentinel(allPublicSurfaces);
  });

  it("maps provider acceptance followed by a ledger warning to failed_do_not_retry and never sends twice", async () => {
    await stub.setSendBehavior("post_send_warning");
    const files = fixture();
    const first = runCli([
      "send-controlled", "apply",
      "--descriptor", files.descriptorPath,
      "--request-id", files.requestId,
      "--receipt", files.receiptPath,
    ]);
    expect(first.result.exitCode, text(first.result.stderr)).toBe(1);
    expect(text(first.result.stdout)).toBe(`${files.requestId} failed_do_not_retry\n`);
    expect(text(first.result.stderr)).toBe("");
    expect(parseReceipt(files.receiptPath)).toMatchObject({
      terminal_state: "failed_do_not_retry",
      provider_result_state: "accepted_unrecorded",
      idempotent_replay: false,
    });

    const second = runCli([
      "send-controlled", "apply",
      "--descriptor", files.descriptorPath,
      "--request-id", files.requestId,
      "--receipt", files.secondReceiptPath,
    ]);
    expect(second.result.exitCode, text(second.result.stderr)).toBe(1);
    expect(parseReceipt(files.secondReceiptPath)).toMatchObject({
      terminal_state: "failed_do_not_retry",
      provider_result_state: "outcome_uncertain",
    });
    expect(await stub.sendStats()).toEqual({ providerCalls: 1 });
    assertNoPrivateSentinel([
      text(first.result.stdout),
      text(first.result.stderr),
      readFileSync(files.receiptPath, "utf8"),
      text(second.result.stdout),
      text(second.result.stderr),
      readFileSync(files.secondReceiptPath, "utf8"),
    ].join("\n"));
  });

  it("publishes one complete mode-0600 receipt atomically after the provider call finishes", async () => {
    await stub.setSendBehavior("delayed_success");
    const files = fixture();
    const child = spawnCli([
      "send-controlled", "apply",
      "--descriptor", files.descriptorPath,
      "--request-id", files.requestId,
      "--receipt", files.receiptPath,
    ]);

    let providerCalls = 0;
    for (let attempt = 0; attempt < 100; attempt++) {
      providerCalls = (await stub.sendStats()).providerCalls;
      if (providerCalls === 1) break;
      await Bun.sleep(10);
    }
    expect(providerCalls).toBe(1);
    expect(existsSync(files.receiptPath)).toBe(false);

    const [exitCode, stdout, stderr] = await Promise.all([
      child.process.exited,
      new Response(child.process.stdout).text(),
      new Response(child.process.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(stdout).toBe(`${files.requestId} sent\n`);
    expect(stderr).toBe("");
    expect(statSync(files.receiptPath).mode & 0o777).toBe(0o600);
    expect(parseReceipt(files.receiptPath).terminal_state).toBe("sent");
    expect(readdirSync(files.dir).some((name) => name.endsWith(".pending"))).toBe(false);
  });

  it("rejects insecure, symlinked, non-regular, malformed, and colliding inputs before any send", async () => {
    const cases: Array<{
      name: string;
      prepare: () => { descriptorPath: string; requestId: string; receiptPath: string };
    }> = [
      {
        name: "group-readable descriptor",
        prepare: () => {
          const files = fixture();
          chmodSync(files.descriptorPath, 0o640);
          return files;
        },
      },
      {
        name: "symlink descriptor",
        prepare: () => {
          const files = fixture();
          const link = join(files.dir, "request-link.json");
          symlinkSync(files.descriptorPath, link);
          return { ...files, descriptorPath: link };
        },
      },
      {
        name: "non-regular descriptor",
        prepare: () => {
          const files = fixture();
          const directory = join(files.dir, "request-directory");
          mkdirSync(directory, { mode: 0o700 });
          return { ...files, descriptorPath: directory };
        },
      },
      {
        name: "missing idempotency key",
        prepare: () => {
          const files = fixture({ idempotency_key: undefined });
          return files;
        },
      },
      {
        name: "schema error",
        prepare: () => {
          const files = fixture({ to: [{ private: "TO_PRIVATE_SENTINEL" }] });
          return files;
        },
      },
      {
        name: "receipt collision",
        prepare: () => {
          const files = fixture();
          writeFileSync(files.receiptPath, "existing", { mode: 0o600 });
          return files;
        },
      },
      {
        name: "insecure receipt directory",
        prepare: () => {
          const files = fixture();
          const outputDir = privateDir("emails-controlled-receipt-");
          chmodSync(outputDir, 0o750);
          return { ...files, receiptPath: join(outputDir, "receipt.json") };
        },
      },
    ];

    for (const testCase of cases) {
      await stub.reset();
      const files = testCase.prepare();
      const result = runCli([
        "--json", "send-controlled", "apply",
        "--descriptor", files.descriptorPath,
        "--request-id", files.requestId,
        "--receipt", files.receiptPath,
      ]);
      expect(result.result.exitCode, testCase.name).toBe(1);
      const publicOutput = `${text(result.result.stdout)}\n${text(result.result.stderr)}`;
      assertNoPrivateSentinel(publicOutput);
      expect(await stub.sendStats(), testCase.name).toEqual({ providerCalls: 0 });
      expect(await stub.list("messages"), testCase.name).toHaveLength(0);
      if (testCase.name === "receipt collision") {
        expect(readFileSync(files.receiptPath, "utf8")).toBe("existing");
      } else if (testCase.name !== "insecure receipt directory") {
        const receipt = parseReceipt(files.receiptPath);
        expect(receipt.terminal_state, testCase.name).toBe("rejected");
        assertNoPrivateSentinel(JSON.stringify(receipt));
      }
    }
  });

  it("preserves the existing inline send command", () => {
    const result = runCli([
      "send",
      "--from", "inline@sender.example",
      "--to", "inline@recipient.example",
      "--subject", "inline compatibility",
      "--body", "synthetic body",
    ]);
    expect(result.result.exitCode, text(result.result.stderr)).toBe(0);
    expect(text(result.result.stdout)).toContain("Email sent to inline@recipient.example");
  });
});
