import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, open, realpath, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { selfHostedApiRequest } from "../db/self-hosted-store.js";
import { SELF_HOSTED_SEND_ATTACHMENT_LIMITS } from "./send-attachment-limits.js";

const MAX_DESCRIPTOR_BYTES = 128 * 1024;
const MAX_BODY_SOURCE_BYTES = 2 * 1024 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MIME_TYPE_RE = /^[A-Za-z0-9!#$&^_.+~-]+\/[A-Za-z0-9!#$&^_.+~-]+$/;
const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_MESSAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CONTROL_OR_BIDI_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export type ControlledSendTerminalState =
  | "sent"
  | "idempotent_replay"
  | "in_progress"
  | "failed_retry_safe"
  | "failed_do_not_retry"
  | "rejected";

export interface ControlledSendReceipt {
  request_id: string;
  terminal_state: ControlledSendTerminalState;
  provider_result_state:
    | "accepted_and_recorded"
    | "accepted_unrecorded"
    | "in_progress"
    | "not_sent"
    | "outcome_uncertain"
    | "not_attempted";
  message_id: string | null;
  idempotent_replay: boolean;
  receipt_path: string;
  started_at: string;
  completed_at: string;
}

export interface ControlledSendExecution {
  receipt: ControlledSendReceipt;
  exitCode: 0 | 1;
  /** Safe human diagnostic; never contains descriptor values. */
  diagnostic?: string;
}

export class ControlledSendPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlledSendPathError";
  }
}

class ControlledDescriptorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlledDescriptorError";
  }
}

interface ControlledDescriptorIdentity {
  requestId: string;
  idempotencyKey: string;
  record: Record<string, unknown>;
}

interface ControlledSendPayload {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  reply_to?: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{ filename: string; content: string; content_type: string }>;
  idempotency_key: string;
}

interface SafeOutcome {
  terminalState: ControlledSendTerminalState;
  providerResultState: ControlledSendReceipt["provider_result_state"];
  messageId: string | null;
  idempotentReplay: boolean;
  diagnostic?: string;
}

function effectiveUid(): number {
  if (process.platform !== "linux" || typeof process.geteuid !== "function") {
    throw new ControlledSendPathError("controlled send files require Linux owner and no-follow checks");
  }
  const uid = process.geteuid();
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new ControlledSendPathError("controlled send files require a valid effective user id");
  }
  return uid;
}

function sameIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function schemaError(path: string, expectation: string): ControlledDescriptorError {
  return new ControlledDescriptorError(`descriptor ${path} ${expectation}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(record).some((key) => !allowedSet.has(key))) {
    throw schemaError(path, "contains an unsupported field");
  }
}

function wellFormedString(value: unknown, path: string, maxChars: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars) {
    throw schemaError(path, `must be a non-empty string of at most ${maxChars} characters`);
  }
  if (CONTROL_OR_BIDI_RE.test(value)) throw schemaError(path, "contains unsafe control characters");
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw schemaError(path, "contains invalid Unicode");
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw schemaError(path, "contains invalid Unicode");
    }
  }
  return value;
}

function opaqueRequestId(value: unknown, path: string): string {
  const requestId = wellFormedString(value, path, 128);
  if (!OPAQUE_ID_RE.test(requestId)) {
    throw schemaError(path, "must be an opaque terminal-safe identifier");
  }
  return requestId;
}

function idempotencyKey(value: unknown): string {
  const key = wellFormedString(value, "$.idempotency_key", 200).trim();
  if (!key) throw schemaError("$.idempotency_key", "is required");
  return key;
}

function stringList(value: unknown, path: string, required: boolean): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || (required && value.length === 0)) {
    throw schemaError(path, required ? "must be a non-empty array" : "must be an array");
  }
  return value.map((entry, index) => wellFormedString(entry, `${path}[${index}]`, 320));
}

async function inspectPrivateDirectory(path: string, label: string, uid: number): Promise<Stats> {
  let before: Stats;
  let after: Stats;
  let canonical: string;
  try {
    before = await lstat(path);
    canonical = await realpath(path);
    after = await lstat(path);
  } catch {
    throw new ControlledSendPathError(`${label} parent directory must exist and be owner-only mode 0700`);
  }
  if (before.isSymbolicLink()
    || after.isSymbolicLink()
    || !before.isDirectory()
    || !after.isDirectory()
    || !sameIdentity(before, after)
    || canonical !== path
    || after.uid !== uid
    || (after.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw new ControlledSendPathError(`${label} parent directory must be a real owner-only mode 0700 directory`);
  }
  return after;
}

async function readPrivateFile(pathValue: unknown, label: string, maxBytes: number): Promise<Buffer> {
  if (typeof pathValue !== "string" || !pathValue.trim()) {
    throw new ControlledDescriptorError(`${label} must be a private file path`);
  }
  const uid = effectiveUid();
  let path: string;
  try {
    path = resolve(pathValue);
  } catch {
    throw new ControlledDescriptorError(`${label} must be a private file path`);
  }
  const parent = dirname(path);
  const parentBefore = await inspectPrivateDirectory(parent, label, uid)
    .catch((error) => {
      throw new ControlledDescriptorError(error instanceof Error ? error.message : `${label} parent directory is invalid`);
    });

  let pathBefore: Stats;
  try {
    pathBefore = await lstat(path);
  } catch {
    throw new ControlledDescriptorError(`${label} must be a readable regular owner-only mode 0600 file`);
  }
  if (pathBefore.isSymbolicLink()
    || !pathBefore.isFile()
    || pathBefore.uid !== uid
    || (pathBefore.mode & 0o777) !== PRIVATE_FILE_MODE
    || pathBefore.size > maxBytes) {
    throw new ControlledDescriptorError(
      `${label} must be a regular owner-only mode 0600 file no larger than ${maxBytes} bytes`,
    );
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  if (!noFollow) throw new ControlledDescriptorError(`${label} requires no-follow filesystem support`);

  let file: FileHandle;
  try {
    file = await open(path, constants.O_RDONLY | noFollow);
  } catch {
    throw new ControlledDescriptorError(`${label} must be a readable regular owner-only mode 0600 file`);
  }
  try {
    const opened = await file.stat();
    if (!opened.isFile()
      || !sameIdentity(pathBefore, opened)
      || opened.uid !== uid
      || (opened.mode & 0o777) !== PRIVATE_FILE_MODE
      || opened.size > maxBytes) {
      throw new ControlledDescriptorError(`${label} changed during private-file validation`);
    }
    const bytes = Buffer.alloc(opened.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.byteLength, 0);
    if (bytesRead !== opened.size) {
      throw new ControlledDescriptorError(`${label} changed while it was being read`);
    }
    const [openedAfter, pathAfter, parentAfter] = await Promise.all([
      file.stat(),
      lstat(path).catch(() => null),
      inspectPrivateDirectory(parent, label, uid).catch(() => null),
    ]);
    if (!openedAfter.isFile()
      || openedAfter.size !== opened.size
      || !sameIdentity(opened, openedAfter)
      || !pathAfter
      || pathAfter.isSymbolicLink()
      || !pathAfter.isFile()
      || !sameIdentity(opened, pathAfter)
      || !parentAfter
      || !sameIdentity(parentBefore, parentAfter)) {
      throw new ControlledDescriptorError(`${label} changed while it was being read`);
    }
    return bytes.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

function parseDescriptorIdentity(bytes: Buffer, expectedRequestId: string): ControlledDescriptorIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw schemaError("$", "must be valid JSON");
  }
  if (!isRecord(parsed)) throw schemaError("$", "must be an object");
  assertExactKeys(parsed, [
    "attachments",
    "bcc",
    "cc",
    "from",
    "html",
    "html_file",
    "idempotency_key",
    "reply_to",
    "request_id",
    "subject",
    "text",
    "text_file",
    "to",
  ], "$");
  const descriptorRequestId = opaqueRequestId(parsed["request_id"], "$.request_id");
  if (descriptorRequestId !== expectedRequestId) {
    throw schemaError("$.request_id", "must match --request-id");
  }
  return {
    requestId: descriptorRequestId,
    idempotencyKey: idempotencyKey(parsed["idempotency_key"]),
    record: parsed,
  };
}

async function bodySource(
  record: Record<string, unknown>,
  inlineKey: "text" | "html",
  fileKey: "text_file" | "html_file",
): Promise<string | undefined> {
  const inline = record[inlineKey];
  const filePath = record[fileKey];
  if (inline !== undefined && filePath !== undefined) {
    throw schemaError(`$.${inlineKey}`, `cannot be combined with $.${fileKey}`);
  }
  if (inline !== undefined) {
    if (typeof inline !== "string") throw schemaError(`$.${inlineKey}`, "must be a string");
    if (Buffer.byteLength(inline, "utf8") > MAX_BODY_SOURCE_BYTES) {
      throw schemaError(`$.${inlineKey}`, `must be at most ${MAX_BODY_SOURCE_BYTES} UTF-8 bytes`);
    }
    return inline;
  }
  if (filePath !== undefined) {
    return (await readPrivateFile(filePath, `descriptor $.${fileKey}`, MAX_BODY_SOURCE_BYTES)).toString("utf8");
  }
  return undefined;
}

async function parseSendPayload(identity: ControlledDescriptorIdentity): Promise<ControlledSendPayload> {
  const record = identity.record;
  const from = wellFormedString(record["from"], "$.from", 320);
  const to = stringList(record["to"], "$.to", true);
  const cc = stringList(record["cc"], "$.cc", false);
  const bcc = stringList(record["bcc"], "$.bcc", false);
  const subject = wellFormedString(record["subject"], "$.subject", 998);
  const replyTo = record["reply_to"] === undefined
    ? undefined
    : wellFormedString(record["reply_to"], "$.reply_to", 320);
  const text = await bodySource(record, "text", "text_file");
  const html = await bodySource(record, "html", "html_file");
  if (text === undefined && html === undefined) {
    throw schemaError("$.text", "or $.html must provide a message body source");
  }

  const rawAttachments = record["attachments"];
  let attachments: ControlledSendPayload["attachments"];
  if (rawAttachments !== undefined) {
    if (!Array.isArray(rawAttachments)) throw schemaError("$.attachments", "must be an array");
    if (rawAttachments.length > SELF_HOSTED_SEND_ATTACHMENT_LIMITS.maxFiles) {
      throw schemaError("$.attachments", `must contain at most ${SELF_HOSTED_SEND_ATTACHMENT_LIMITS.maxFiles} files`);
    }
    let totalBytes = 0;
    attachments = [];
    for (const [index, value] of rawAttachments.entries()) {
      const path = `$.attachments[${index}]`;
      if (!isRecord(value)) throw schemaError(path, "must be an object");
      assertExactKeys(value, ["content_type", "filename", "path"], path);
      const content = await readPrivateFile(
        value["path"],
        `descriptor ${path}.path`,
        SELF_HOSTED_SEND_ATTACHMENT_LIMITS.maxBytesPerFile,
      );
      totalBytes += content.byteLength;
      if (totalBytes > SELF_HOSTED_SEND_ATTACHMENT_LIMITS.maxTotalBytes) {
        throw schemaError("$.attachments", `must total at most ${SELF_HOSTED_SEND_ATTACHMENT_LIMITS.maxTotalBytes} bytes`);
      }
      const filename = value["filename"] === undefined
        ? basename(String(value["path"]))
        : wellFormedString(value["filename"], `${path}.filename`, 255);
      if (!filename || filename === "." || filename === "..") {
        throw schemaError(`${path}.filename`, "must be a safe filename");
      }
      const contentType = value["content_type"] === undefined
        ? "application/octet-stream"
        : wellFormedString(value["content_type"], `${path}.content_type`, 255);
      if (!MIME_TYPE_RE.test(contentType)) {
        throw schemaError(`${path}.content_type`, "must be a safe MIME type");
      }
      attachments.push({
        filename,
        content: content.toString("base64"),
        content_type: contentType,
      });
    }
  }

  return {
    from,
    to,
    ...(cc.length ? { cc } : {}),
    ...(bcc.length ? { bcc } : {}),
    ...(replyTo ? { reply_to: replyTo } : {}),
    subject,
    ...(text !== undefined ? { text } : {}),
    ...(html !== undefined ? { html } : {}),
    ...(attachments?.length ? { attachments } : {}),
    idempotency_key: identity.idempotencyKey,
  };
}

function safeMessageId(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const message = payload["message"];
  if (!isRecord(message)) return null;
  const id = message["id"];
  return typeof id === "string" && SAFE_MESSAGE_ID_RE.test(id) ? id : null;
}

function sendOutcome(status: number, payload: unknown): SafeOutcome {
  const body = isRecord(payload) ? payload : {};
  const messageId = safeMessageId(body);
  if (status >= 200 && status < 300) {
    if (body["in_progress"] === true) {
      return {
        terminalState: "in_progress",
        providerResultState: "in_progress",
        messageId,
        idempotentReplay: false,
      };
    }
    if (body["sent"] === true && typeof body["warning"] === "string") {
      return {
        terminalState: "failed_do_not_retry",
        providerResultState: "accepted_unrecorded",
        messageId,
        idempotentReplay: false,
      };
    }
    if (body["sent"] === true && body["idempotent_replay"] === true) {
      return {
        terminalState: "idempotent_replay",
        providerResultState: "accepted_and_recorded",
        messageId,
        idempotentReplay: true,
      };
    }
    if (body["sent"] === true) {
      return {
        terminalState: "sent",
        providerResultState: "accepted_and_recorded",
        messageId,
        idempotentReplay: false,
      };
    }
    return {
      terminalState: "failed_do_not_retry",
      providerResultState: "outcome_uncertain",
      messageId,
      idempotentReplay: false,
    };
  }
  if (body["sent"] === false && body["retry_safe"] === true) {
    return {
      terminalState: "failed_retry_safe",
      providerResultState: "not_sent",
      messageId,
      idempotentReplay: false,
    };
  }
  if (body["sent"] === null || body["retry_safe"] === false || status >= 500) {
    return {
      terminalState: "failed_do_not_retry",
      providerResultState: "outcome_uncertain",
      messageId,
      idempotentReplay: false,
    };
  }
  return {
    terminalState: "rejected",
    providerResultState: "not_attempted",
    messageId,
    idempotentReplay: false,
    diagnostic: "the server rejected the controlled request before provider send",
  };
}

function readbackOutcome(status: number, payload: unknown): SafeOutcome {
  if (status < 200 || status >= 300 || !isRecord(payload)) {
    return {
      terminalState: status >= 500 ? "failed_do_not_retry" : "rejected",
      providerResultState: status >= 500 ? "outcome_uncertain" : "not_attempted",
      messageId: null,
      idempotentReplay: false,
    };
  }
  const lookup = payload["send_intent"];
  if (!isRecord(lookup) || lookup["found"] !== true) {
    return {
      terminalState: "failed_retry_safe",
      providerResultState: "not_sent",
      messageId: null,
      idempotentReplay: false,
    };
  }
  const message = isRecord(lookup["message"]) ? lookup["message"] : {};
  const rawId = message["id"];
  const messageId = typeof rawId === "string" && SAFE_MESSAGE_ID_RE.test(rawId) ? rawId : null;
  const sendState = typeof message["send_state"] === "string" ? message["send_state"] : "";
  if (sendState === "sent") {
    return {
      terminalState: "sent",
      providerResultState: "accepted_and_recorded",
      messageId,
      idempotentReplay: false,
    };
  }
  if (sendState === "pending" || sendState === "sending") {
    return {
      terminalState: "in_progress",
      providerResultState: "in_progress",
      messageId,
      idempotentReplay: false,
    };
  }
  if (sendState === "failed") {
    return {
      terminalState: "failed_retry_safe",
      providerResultState: "not_sent",
      messageId,
      idempotentReplay: false,
    };
  }
  if (sendState === "uncertain" || lookup["reconciliation_required"] === true) {
    return {
      terminalState: "failed_do_not_retry",
      providerResultState: "outcome_uncertain",
      messageId,
      idempotentReplay: false,
    };
  }
  return {
    terminalState: "rejected",
    providerResultState: "not_attempted",
    messageId,
    idempotentReplay: false,
  };
}

class ReceiptReservation {
  constructor(
    readonly path: string,
    private readonly reservationPath: string,
    private readonly file: FileHandle,
    private readonly identity: { dev: number; ino: number },
  ) {}

  async finalize(receipt: ControlledSendReceipt): Promise<void> {
    const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
    let fileClosed = false;
    try {
      await this.file.writeFile(serialized, { encoding: "utf8" });
      await this.file.sync();
      await this.file.chmod(PRIVATE_FILE_MODE);
      const after = await this.file.stat();
      const reservationAfter = await lstat(this.reservationPath).catch(() => null);
      if (!after.isFile()
        || !sameIdentity(this.identity, after)
        || (after.mode & 0o777) !== PRIVATE_FILE_MODE
        || after.size !== Buffer.byteLength(serialized)
        || !reservationAfter
        || reservationAfter.isSymbolicLink()
        || !reservationAfter.isFile()
        || !sameIdentity(this.identity, reservationAfter)) {
        throw new Error("receipt reservation changed during finalization");
      }
      await this.file.close();
      fileClosed = true;

      // A hard link publishes the already-complete inode atomically and refuses
      // to overwrite an existing terminal receipt. The deterministic private
      // reservation remains outside the public receipt path if the process dies.
      await link(this.reservationPath, this.path);
      const [published, reservationPublished] = await Promise.all([
        lstat(this.path),
        lstat(this.reservationPath),
      ]);
      if (!published.isFile()
        || published.isSymbolicLink()
        || !sameIdentity(this.identity, published)
        || (published.mode & 0o777) !== PRIVATE_FILE_MODE
        || published.size !== Buffer.byteLength(serialized)
        || !reservationPublished.isFile()
        || reservationPublished.isSymbolicLink()
        || !sameIdentity(this.identity, reservationPublished)) {
        throw new Error("receipt publication did not preserve the completed reservation");
      }
      await unlink(this.reservationPath).catch(() => undefined);
    } catch {
      throw new ControlledSendPathError(
        "controlled receipt could not be finalized; read back the same request before any retry",
      );
    } finally {
      if (!fileClosed) await this.file.close().catch(() => undefined);
    }
  }
}

async function reserveReceipt(pathValue: string): Promise<ReceiptReservation> {
  if (!pathValue.trim()) throw new ControlledSendPathError("--receipt is required");
  const uid = effectiveUid();
  let path: string;
  try {
    path = resolve(pathValue);
  } catch {
    throw new ControlledSendPathError("--receipt must be a valid owner-only path");
  }
  await inspectPrivateDirectory(dirname(path), "--receipt", uid);
  try {
    await lstat(path);
    throw new ControlledSendPathError("--receipt already exists; controlled receipts never overwrite");
  } catch (error) {
    if (error instanceof ControlledSendPathError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ControlledSendPathError("--receipt collision check failed before send");
    }
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  if (!noFollow) throw new ControlledSendPathError("--receipt requires no-follow filesystem support");
  const reservationName = `.controlled-send-${createHash("sha256").update(path).digest("hex").slice(0, 32)}.pending`;
  const reservationPath = join(dirname(path), reservationName);
  let file: FileHandle;
  try {
    file = await open(
      reservationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      PRIVATE_FILE_MODE,
    );
  } catch {
    throw new ControlledSendPathError(
      "--receipt already exists or has an unfinished controlled-send reservation",
    );
  }
  try {
    await file.chmod(PRIVATE_FILE_MODE);
    const stat = await file.stat();
    if (!stat.isFile()
      || stat.uid !== uid
      || (stat.mode & 0o777) !== PRIVATE_FILE_MODE
      || stat.size !== 0) {
      throw new ControlledSendPathError("--receipt could not be reserved as an owner-only mode 0600 file");
    }
    try {
      await lstat(path);
      throw new ControlledSendPathError("--receipt already exists; controlled receipts never overwrite");
    } catch (error) {
      if (error instanceof ControlledSendPathError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ControlledSendPathError("--receipt collision check failed before send");
      }
    }
    return new ReceiptReservation(path, reservationPath, file, { dev: stat.dev, ino: stat.ino });
  } catch (error) {
    await file.close();
    await unlink(reservationPath).catch(() => undefined);
    throw error;
  }
}

function receiptFor(
  requestId: string,
  receiptPath: string,
  startedAt: string,
  outcome: SafeOutcome,
): ControlledSendReceipt {
  return {
    request_id: requestId,
    terminal_state: outcome.terminalState,
    provider_result_state: outcome.providerResultState,
    message_id: outcome.messageId,
    idempotent_replay: outcome.idempotentReplay,
    receipt_path: receiptPath,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
  };
}

export async function executeControlledSend(
  operation: "apply" | "readback",
  options: { descriptorPath: string; requestId: string; receiptPath: string },
): Promise<ControlledSendExecution> {
  const requestId = opaqueRequestId(options.requestId, "--request-id");
  const startedAt = new Date().toISOString();
  const reservation = await reserveReceipt(options.receiptPath);
  let outcome: SafeOutcome;
  try {
    const descriptorBytes = await readPrivateFile(
      options.descriptorPath,
      "descriptor path",
      MAX_DESCRIPTOR_BYTES,
    );
    const identity = parseDescriptorIdentity(descriptorBytes, requestId);
    if (operation === "readback") {
      const response = selfHostedApiRequest("POST", "/messages/send-intents/lookup", {
        idempotency_key: identity.idempotencyKey,
      });
      outcome = readbackOutcome(response.status, response.json);
    } else {
      const payload = await parseSendPayload(identity);
      const response = selfHostedApiRequest("POST", "/messages/send", payload);
      outcome = sendOutcome(response.status, response.json);
    }
  } catch (error) {
    if (error instanceof ControlledDescriptorError) {
      outcome = {
        terminalState: "rejected",
        providerResultState: "not_attempted",
        messageId: null,
        idempotentReplay: false,
        diagnostic: error.message,
      };
    } else {
      // Once descriptor validation has completed, a transport/response failure
      // cannot prove that the server did not claim or send the request.
      outcome = {
        terminalState: "failed_do_not_retry",
        providerResultState: "outcome_uncertain",
        messageId: null,
        idempotentReplay: false,
      };
    }
  }

  const receipt = receiptFor(requestId, reservation.path, startedAt, outcome);
  await reservation.finalize(receipt);
  return {
    receipt,
    exitCode: outcome.terminalState === "sent" || outcome.terminalState === "idempotent_replay" ? 0 : 1,
    ...(outcome.diagnostic ? { diagnostic: outcome.diagnostic } : {}),
  };
}
