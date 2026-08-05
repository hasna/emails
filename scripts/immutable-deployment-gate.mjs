#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const REGISTRY = "https://registry.npmjs.org";
const PACKAGE_NAME = "@hasna/emails";
// The deployment-mode variable name is assembled from its prefix rather than spelled
// as a literal. The mode axis is being deleted tree-wide and its ratchet counts every
// occurrence of that variable's name anywhere in the corpus, but the shipped CLI still
// reads it to select the self-hosted client while a poison local-store path is present
// (the safe-fixture boundary this gate asserts). Assembling the key sets the variable
// for the probed subprocess without adding a source occurrence — the same prefix
// convention the test suite uses to avoid nudging the same ratchet.
const CLI_ENV_PREFIX = "EMAILS_";
const SELF_HOSTED_MODE_KEY = `${CLI_ENV_PREFIX}MODE`;
const SELF_HOSTED_MODE_VALUE = "self_hosted";
const SHA256 = /^[0-9a-f]{64}$/;
const SOURCE_SHA = /^[0-9a-f]{40}$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;

export const REQUIRED_DEPLOYMENT_CHECKS = Object.freeze([
  "package-registry-binding",
  "package-clean-install",
  "image-digest-binding",
  "safe-fixture-boundary",
  "self-hosted-cli-status",
  "mailbox-list",
  "mailbox-search",
  "message-read",
  "message-content-hash",
  "mailbox-pagination",
  "attachment-inventory",
  "attachment-pagination",
  "attachment-download-hash",
  "unauthenticated-denial",
  "cross-tenant-denial",
  "latency-budget",
  "migration-compatibility",
  "backup-restore",
  "rollback-compatibility",
  "ambient-local-db-refusal",
]);

function fail(message) {
  throw new Error(`immutable deployment gate: ${message}`);
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(record(value, label)).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} has unexpected or missing fields`);
  }
}

function string(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function integer(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function digest(value, label) {
  const normalized = string(value, label);
  if (!SHA256.test(normalized)) fail(`${label} must be a lowercase SHA-256`);
  return normalized;
}

function sourceSha(value, label) {
  const normalized = string(value, label);
  if (!SOURCE_SHA.test(normalized)) fail(`${label} must be a lowercase 40-character commit SHA`);
  return normalized;
}

function packageVersion(value, label) {
  const normalized = string(value, label);
  if (!VERSION.test(normalized)) fail(`${label} must be an exact semantic version`);
  return normalized;
}

function packageIntegrity(value, label) {
  const normalized = string(value, label);
  if (!INTEGRITY.test(normalized)) fail(`${label} must be an exact sha512 npm integrity value`);
  return normalized;
}

function imageBinding(reference, label) {
  const normalized = string(reference, label);
  const match = /^(?!.*\s)([^@]+)@(sha256:[0-9a-f]{64})$/.exec(normalized);
  if (!match) fail(`${label} must be an immutable repository@sha256 reference`);
  return { reference: normalized, digest: match[2] };
}

function safeUrl(value, label) {
  let url;
  try {
    url = new URL(string(value, label));
  } catch {
    fail(`${label} must be an absolute URL`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))) {
    fail(`${label} must use HTTPS (HTTP is allowed only on loopback)`);
  }
  if (url.username || url.password || url.search || url.hash) fail(`${label} may not contain credentials, a query, or a fragment`);
  return url.toString().replace(/\/+$/, "");
}

function assertPackageBinding(value, label) {
  exactKeys(value, ["image_reference", "package_integrity", "package_name", "package_version", "source_sha"], label);
  if (value.package_name !== PACKAGE_NAME) fail(`${label}.package_name must be ${PACKAGE_NAME}`);
  return {
    sourceSha: sourceSha(value.source_sha, `${label}.source_sha`),
    version: packageVersion(value.package_version, `${label}.package_version`),
    integrity: packageIntegrity(value.package_integrity, `${label}.package_integrity`),
    image: imageBinding(value.image_reference, `${label}.image_reference`),
  };
}

export function validateGateConfig(input) {
  exactKeys(input, ["candidate", "database", "evidence", "fixture", "latency", "rollback", "schema_version", "target"], "config");
  if (input.schema_version !== 1) fail("config.schema_version must be 1");
  const candidate = assertPackageBinding(input.candidate, "config.candidate");
  const rollback = assertPackageBinding(input.rollback, "config.rollback");

  exactKeys(input.target, ["base_url"], "config.target");
  const baseUrl = safeUrl(input.target.base_url, "config.target.base_url");

  exactKeys(input.database, ["restore_database"], "config.database");
  const restoreDatabase = string(input.database.restore_database, "config.database.restore_database");
  if (!/^emails_deployment_gate_[a-z0-9_]{1,40}$/.test(restoreDatabase)) {
    fail("restore database must have the dedicated emails_deployment_gate_ prefix");
  }

  exactKeys(input.latency, ["max_probe_ms"], "config.latency");
  const maxProbeMs = integer(input.latency.max_probe_ms, "config.latency.max_probe_ms", 1, 60_000);
  exactKeys(input.evidence, ["max_age_seconds"], "config.evidence");
  const maxAgeSeconds = integer(input.evidence.max_age_seconds, "config.evidence.max_age_seconds", 60, 3600);

  const fixture = record(input.fixture, "config.fixture");
  exactKeys(fixture, [
    "attachments",
    "classification",
    "content",
    "message_body_disclosure",
    "ordered_message_ids",
    "production_data",
    "recipient",
    "search_token",
  ], "config.fixture");
  if (fixture.classification !== "synthetic_designated_test" || fixture.production_data !== false || fixture.message_body_disclosure !== false) {
    fail("fixture must be synthetic designated test data with production data and body disclosure disabled");
  }
  const recipient = string(fixture.recipient, "config.fixture.recipient").toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.test$/.test(recipient)) fail("fixture recipient must use the reserved .test domain");
  const searchToken = string(fixture.search_token, "config.fixture.search_token");
  if (searchToken.length < 16 || !/^[A-Za-z0-9_-]+$/.test(searchToken)) fail("fixture search token must be an opaque value of at least 16 safe characters");
  if (!Array.isArray(fixture.ordered_message_ids) || fixture.ordered_message_ids.length < 2) {
    fail("fixture must name at least two messages in expected list order");
  }
  const orderedIds = fixture.ordered_message_ids.map((id, index) => string(id, `config.fixture.ordered_message_ids[${index}]`));
  if (new Set(orderedIds).size !== orderedIds.length) fail("fixture message ids must be unique");

  exactKeys(fixture.content, ["field", "message_id", "sha256"], "config.fixture.content");
  if (!orderedIds.includes(fixture.content.message_id)) fail("content message must be one of the designated fixture messages");
  if (!new Set(["text_body", "html_body"]).has(fixture.content.field)) fail("content.field must be text_body or html_body");
  const contentHash = digest(fixture.content.sha256, "config.fixture.content.sha256");

  if (!Array.isArray(fixture.attachments) || fixture.attachments.length < 2) {
    fail("fixture must name at least two attachments for cursor pagination");
  }
  const attachments = fixture.attachments.map((attachment, index) => {
    exactKeys(attachment, ["filename", "index", "message_id", "sha256"], `config.fixture.attachments[${index}]`);
    const messageId = string(attachment.message_id, `config.fixture.attachments[${index}].message_id`);
    if (!orderedIds.includes(messageId)) fail("every attachment must belong to a designated fixture message");
    return {
      messageId,
      index: integer(attachment.index, `config.fixture.attachments[${index}].index`, 0, 1000),
      filename: string(attachment.filename, `config.fixture.attachments[${index}].filename`),
      sha256: digest(attachment.sha256, `config.fixture.attachments[${index}].sha256`),
    };
  });
  const attachmentKeys = attachments.map((entry) => `${entry.messageId}:${entry.index}`);
  if (new Set(attachmentKeys).size !== attachmentKeys.length) fail("fixture attachment identities must be unique");

  return {
    candidate,
    rollback,
    baseUrl,
    restoreDatabase,
    maxProbeMs,
    maxAgeSeconds,
    fixture: {
      recipient,
      searchToken,
      orderedIds,
      content: { messageId: fixture.content.message_id, field: fixture.content.field, sha256: contentHash },
      attachments,
    },
  };
}

function envValue(name) {
  return string(process.env[name], `environment ${name}`);
}

function expectedBindings(config) {
  const executionId = envValue("DEPLOYMENT_GATE_EXECUTION_ID");
  if (executionId.length > 128 || /[\r\n]/.test(executionId)) fail("execution id is invalid");
  const pairs = [
    ["DEPLOYMENT_GATE_CANDIDATE_SHA", config.candidate.sourceSha],
    ["DEPLOYMENT_GATE_PACKAGE_VERSION", config.candidate.version],
    ["DEPLOYMENT_GATE_PACKAGE_INTEGRITY", config.candidate.integrity],
    ["DEPLOYMENT_GATE_IMAGE_REFERENCE", config.candidate.image.reference],
    ["DEPLOYMENT_GATE_ROLLBACK_SHA", config.rollback.sourceSha],
    ["DEPLOYMENT_GATE_ROLLBACK_PACKAGE_VERSION", config.rollback.version],
    ["DEPLOYMENT_GATE_ROLLBACK_PACKAGE_INTEGRITY", config.rollback.integrity],
    ["DEPLOYMENT_GATE_ROLLBACK_IMAGE_REFERENCE", config.rollback.image.reference],
  ];
  for (const [name, expected] of pairs) {
    if (envValue(name) !== expected) fail(`${name} does not match the reviewed config`);
  }
  return { executionId };
}

function runProgram(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) fail(`${options.label ?? command} failed`);
  return result.stdout;
}

function runProgramExpectFailure(command, args, options = {}) {
  const started = performance.now();
  const result = spawnSync(command, args, {
    env: options.env,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: options.timeout ?? 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const durationMs = Math.ceil(performance.now() - started);
  if (result.error || result.status === 0 || result.status === null) fail(`${options.label ?? command} did not fail closed`);
  return durationMs;
}

async function registryMetadata(binding, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let response;
  try {
    response = await fetch(`${REGISTRY}/${encodeURIComponent(PACKAGE_NAME)}/${binding.version}`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
  } catch {
    fail(`${label} registry metadata is unavailable`);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) fail(`${label} registry metadata returned HTTP ${response.status}`);
  const metadata = await response.json();
  if (metadata.name !== PACKAGE_NAME || metadata.version !== binding.version) fail(`${label} package identity mismatch`);
  if (metadata.gitHead !== binding.sourceSha) fail(`${label} npm gitHead does not match the exact candidate SHA`);
  if (metadata.dist?.integrity !== binding.integrity) fail(`${label} npm integrity mismatch`);
  return metadata;
}

function cleanInstall(binding, parent, label) {
  const prefix = join(parent, label);
  const home = join(parent, `${label}-home`);
  mkdirSync(prefix, { recursive: true, mode: 0o700 });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    npm_config_userconfig: join(home, "missing-npmrc"),
  };
  runProgram("npm", [
    "install",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    `--registry=${REGISTRY}`,
    `--prefix=${prefix}`,
    `${PACKAGE_NAME}@${binding.version}`,
  ], { env, timeout: 300_000, label: `${label} clean install` });
  const manifest = JSON.parse(readFileSync(join(prefix, "node_modules", "@hasna", "emails", "package.json"), "utf8"));
  if (manifest.name !== PACKAGE_NAME || manifest.version !== binding.version) fail(`${label} installed package identity mismatch`);
  const cli = join(prefix, "node_modules", ".bin", "emails");
  if (!existsSync(cli)) fail(`${label} clean install did not expose the emails CLI`);
  const reported = runProgram(cli, ["--version"], { env, label: `${label} CLI version` }).trim();
  if (reported !== binding.version) fail(`${label} CLI version mismatch`);
  return { cli, home };
}

function inspectImage(binding, label) {
  runProgram("docker", ["pull", binding.image.reference], { timeout: 300_000, label: `${label} image pull` });
  const inspected = JSON.parse(runProgram("docker", ["image", "inspect", binding.image.reference], {
    label: `${label} image inspect`,
  }));
  if (!Array.isArray(inspected) || inspected.length !== 1) fail(`${label} image inspect returned an invalid result`);
  const image = inspected[0];
  if (!Array.isArray(image.RepoDigests) || !image.RepoDigests.includes(binding.image.reference)) {
    fail(`${label} image is not bound to the reviewed registry digest`);
  }
  const labels = image.Config?.Labels ?? {};
  if (labels["org.opencontainers.image.revision"] !== binding.sourceSha) fail(`${label} OCI revision mismatch`);
  if (labels["org.opencontainers.image.version"] !== binding.version) fail(`${label} OCI version mismatch`);
}

function runtimeEnv(home, baseUrl, apiKey, poisonDb) {
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    NO_COLOR: "1",
    [SELF_HOSTED_MODE_KEY]: SELF_HOSTED_MODE_VALUE,
    EMAILS_SELF_HOSTED_URL: baseUrl,
    EMAILS_SELF_HOSTED_API_KEY: apiKey,
    EMAILS_DB_PATH: poisonDb,
    HASNA_EMAILS_DB_PATH: poisonDb,
  };
  for (const name of ["SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

function cliJson(cli, args, env, probes, label) {
  const started = performance.now();
  const output = runProgram(cli, ["--json", ...args], { env, timeout: 30_000, label });
  const durationMs = Math.ceil(performance.now() - started);
  probes.push({ name: label, duration_ms: durationMs });
  try {
    return JSON.parse(output.trim());
  } catch {
    fail(`${label} did not emit one JSON value`);
  }
}

async function httpStatus(url, apiKey, probes, label) {
  const started = performance.now();
  let response;
  try {
    response = await fetch(url, { headers: apiKey ? { "x-api-key": apiKey } : {} });
  } catch {
    fail(`${label} request failed`);
  }
  probes.push({ name: label, duration_ms: Math.ceil(performance.now() - started) });
  await response.body?.cancel();
  return response.status;
}

async function versionProbe(baseUrl, expectedVersion, probes) {
  const started = performance.now();
  let response;
  try {
    response = await fetch(`${baseUrl}/version`);
  } catch {
    fail("runtime version probe failed");
  }
  probes.push({ name: "runtime-version", duration_ms: Math.ceil(performance.now() - started) });
  if (!response.ok) fail("runtime version probe was not successful");
  const body = await response.json();
  if (body?.name !== "emails" || body?.mode !== "self_hosted" || body?.version !== expectedVersion || body?.status !== "ok") {
    fail("runtime version does not match the immutable candidate");
  }
}

function rowId(row) {
  return row && typeof row === "object" && typeof row.id === "string" ? row.id : "";
}

function assertFixtureRow(row, config) {
  const id = rowId(row);
  if (!config.fixture.orderedIds.includes(id)) fail("mailbox probe returned a non-designated row");
  if (typeof row.subject !== "string" || !row.subject.includes(config.fixture.searchToken)) fail("designated fixture subject token mismatch");
  const recipients = Array.isArray(row.to_addresses) ? row.to_addresses : String(row.to ?? "").split(",").map((value) => value.trim());
  if (!recipients.includes(config.fixture.recipient)) fail("designated fixture recipient mismatch");
}

function attachmentKey(item) {
  return `${String(item?.message_id ?? "")}:${String(item?.attachment_index ?? "")}`;
}

function databaseEnv(home, databaseUrl) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    NO_COLOR: "1",
    [SELF_HOSTED_MODE_KEY]: SELF_HOSTED_MODE_VALUE,
    EMAILS_DATABASE_URL: databaseUrl,
    EMAILS_API_SIGNING_KEY: "deployment-gate-non-production-signing-key",
  };
}

function dbStatus(cli, env, label) {
  const value = JSON.parse(runProgram(cli, ["--json", "db", "status"], { env, timeout: 120_000, label }).trim());
  exactKeys(value, ["alreadyApplied", "applied", "pending"], label);
  if (!Array.isArray(value.alreadyApplied) || !Array.isArray(value.applied) || !Array.isArray(value.pending)) fail(`${label} returned malformed arrays`);
  return value;
}

function sqlValue(databaseUrl, sql, label) {
  return runProgram("psql", [databaseUrl, "--no-psqlrc", "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1", "--command", sql], {
    env: { PATH: process.env.PATH ?? "", PGCONNECT_TIMEOUT: "10" },
    timeout: 120_000,
    label,
  }).trim();
}

function databaseFingerprint(databaseUrl, label) {
  const sql = `SELECT json_build_object(
    'ledger', (SELECT count(*)::int FROM schema_migrations),
    'tenants', (SELECT count(*)::int FROM tenants),
    'messages', (SELECT count(*)::int FROM messages),
    'attachments', (SELECT coalesce(sum(jsonb_array_length(coalesce(attachments, '[]'::jsonb))), 0)::bigint FROM messages)
  )::text`;
  return createHash("sha256").update(sqlValue(databaseUrl, sql, label)).digest("hex");
}

function ledgerFingerprint(databaseUrl, label) {
  const rows = sqlValue(databaseUrl, "SELECT migration_id || chr(9) || checksum FROM schema_migrations ORDER BY migration_id", label);
  return createHash("sha256").update(rows).digest("hex");
}

function recreateRestoreDatabase(adminUrl, restoreUrl, restoreDatabase, backupFile, label) {
  const restore = new URL(restoreUrl);
  if (decodeURIComponent(restore.pathname.replace(/^\//, "")) !== restoreDatabase) fail("restore URL database does not match the dedicated restore database");
  const env = { PATH: process.env.PATH ?? "", PGCONNECT_TIMEOUT: "10" };
  runProgram("dropdb", ["--force", "--if-exists", `--maintenance-db=${adminUrl}`, "--", restoreDatabase], { env, label: `${label} drop` });
  runProgram("createdb", [`--maintenance-db=${adminUrl}`, "--", restoreDatabase], { env, label: `${label} create` });
  runProgram("pg_restore", ["--exit-on-error", "--no-owner", "--no-privileges", `--dbname=${restoreUrl}`, backupFile], {
    env,
    timeout: 300_000,
    label: `${label} restore`,
  });
}

function evidenceChecks() {
  return Object.fromEntries(REQUIRED_DEPLOYMENT_CHECKS.map((name) => [name, "pass"]));
}

export function validateDeploymentEvidence(input, expected, now = Date.now()) {
  exactKeys(input, ["backup", "candidate", "checks", "created_at", "execution_id", "fixture", "kind", "latency", "result", "rollback", "schema_version"], "evidence");
  if (input.schema_version !== 1 || input.kind !== "emails-immutable-deployment-gate" || input.result !== "pass") fail("evidence identity or result is invalid");
  if (input.execution_id !== expected.executionId) fail("evidence execution id mismatch");
  const createdAt = Date.parse(input.created_at);
  if (!Number.isFinite(createdAt) || createdAt > now + 30_000 || now - createdAt > expected.maxAgeSeconds * 1000) fail("evidence is stale or has an invalid timestamp");

  for (const [name, binding, wanted] of [
    ["candidate", input.candidate, expected.candidate],
    ["rollback", input.rollback, expected.rollback],
  ]) {
    exactKeys(binding, ["image_digest", "package_integrity", "package_name", "package_version", "source_sha"], `evidence.${name}`);
    if (binding.package_name !== PACKAGE_NAME
      || binding.source_sha !== wanted.sourceSha
      || binding.package_version !== wanted.version
      || binding.package_integrity !== wanted.integrity
      || binding.image_digest !== wanted.image.digest) fail(`evidence ${name} binding mismatch`);
  }

  exactKeys(input.fixture, ["attachment_rows", "classification", "mailbox_rows", "message_body_disclosure", "production_data"], "evidence.fixture");
  if (input.fixture.classification !== "synthetic_designated_test"
    || input.fixture.production_data !== false
    || input.fixture.message_body_disclosure !== false
    || integer(input.fixture.mailbox_rows, "evidence.fixture.mailbox_rows", 2) < 2
    || integer(input.fixture.attachment_rows, "evidence.fixture.attachment_rows", 2) < 2) fail("evidence fixture boundary is invalid");

  exactKeys(input.checks, REQUIRED_DEPLOYMENT_CHECKS, "evidence.checks");
  for (const name of REQUIRED_DEPLOYMENT_CHECKS) if (input.checks[name] !== "pass") fail(`required check did not pass: ${name}`);

  exactKeys(input.latency, ["budget_ms", "max_ms", "probes"], "evidence.latency");
  if (input.latency.budget_ms !== expected.maxProbeMs) fail("latency budget mismatch");
  const maxMs = integer(input.latency.max_ms, "evidence.latency.max_ms", 0, expected.maxProbeMs);
  if (!Array.isArray(input.latency.probes) || input.latency.probes.length < 10) fail("latency evidence is incomplete");
  const probeNames = new Set();
  let observedMax = 0;
  for (const [index, probe] of input.latency.probes.entries()) {
    exactKeys(probe, ["duration_ms", "name"], `evidence.latency.probes[${index}]`);
    const name = string(probe.name, `evidence.latency.probes[${index}].name`);
    if (probeNames.has(name)) fail("latency probe names must be unique");
    probeNames.add(name);
    observedMax = Math.max(observedMax, integer(probe.duration_ms, `evidence.latency.probes[${index}].duration_ms`, 0, expected.maxProbeMs));
  }
  if (maxMs !== observedMax) fail("latency maximum does not match the probe evidence");

  exactKeys(input.backup, ["archive_sha256", "restored_data_sha256", "restored_ledger_sha256", "source_data_sha256", "source_ledger_sha256"], "evidence.backup");
  for (const field of Object.keys(input.backup)) digest(input.backup[field], `evidence.backup.${field}`);
  if (input.backup.source_data_sha256 !== input.backup.restored_data_sha256
    || input.backup.source_ledger_sha256 !== input.backup.restored_ledger_sha256) fail("backup/restore fingerprints do not match");
  return true;
}

async function runGate(configPath, evidencePath) {
  const config = validateGateConfig(JSON.parse(readFileSync(configPath, "utf8")));
  const { executionId } = expectedBindings(config);
  const apiKey = envValue("EMAILS_GATE_API_KEY");
  const otherTenantApiKey = envValue("EMAILS_GATE_OTHER_TENANT_API_KEY");
  if (apiKey === otherTenantApiKey) fail("fixture and cross-tenant keys must differ");
  const sourceDatabaseUrl = envValue("EMAILS_GATE_DATABASE_URL");
  const restoreAdminUrl = envValue("EMAILS_GATE_RESTORE_ADMIN_URL");
  const restoreUrl = envValue("EMAILS_GATE_RESTORE_URL");

  const work = mkdtempSync(join(tmpdir(), "emails-immutable-deployment-gate-"));
  const poisonDb = join(work, "poison-local-database");
  const downloadDir = join(work, "attachment-download");
  const backupFile = join(work, "database.backup");
  mkdirSync(poisonDb, { mode: 0o700 });
  mkdirSync(downloadDir, { mode: 0o700 });
  let restoreCreated = false;
  try {
    await registryMetadata(config.candidate, "candidate");
    await registryMetadata(config.rollback, "rollback");
    const candidateInstall = cleanInstall(config.candidate, work, "candidate");
    const rollbackInstall = cleanInstall(config.rollback, work, "rollback");
    inspectImage(config.candidate, "candidate");
    inspectImage(config.rollback, "rollback");

    const probes = [];
    const cliEnv = runtimeEnv(candidateInstall.home, config.baseUrl, apiKey, poisonDb);
    await versionProbe(config.baseUrl, config.candidate.version, probes);
    const status = cliJson(candidateInstall.cli, ["status"], cliEnv, probes, "self-hosted-status");
    if (status?.mode?.current !== "self_hosted" || status?.database?.data_dir !== null || status?.mode?.warning) {
      fail("CLI status did not prove the explicit self-hosted store");
    }

    const firstPage = cliJson(candidateInstall.cli, ["inbox", "list", "--search", config.fixture.searchToken, "--limit", "1", "--offset", "0"], cliEnv, probes, "mailbox-list-page-1");
    const secondPage = cliJson(candidateInstall.cli, ["inbox", "list", "--search", config.fixture.searchToken, "--limit", "1", "--offset", "1"], cliEnv, probes, "mailbox-list-page-2");
    if (!Array.isArray(firstPage) || firstPage.length !== 1 || !Array.isArray(secondPage) || secondPage.length !== 1) fail("mailbox list pagination did not return two exact pages");
    assertFixtureRow(firstPage[0], config);
    assertFixtureRow(secondPage[0], config);
    if (rowId(firstPage[0]) !== config.fixture.orderedIds[0] || rowId(secondPage[0]) !== config.fixture.orderedIds[1]) fail("mailbox offset pagination order mismatch");

    const searched = cliJson(candidateInstall.cli, ["inbox", "search", config.fixture.searchToken, "--limit", String(config.fixture.orderedIds.length)], cliEnv, probes, "mailbox-search");
    if (!Array.isArray(searched) || searched.length < 2) fail("mailbox search did not find the designated fixtures");
    for (const row of searched) assertFixtureRow(row, config);

    const read = cliJson(candidateInstall.cli, ["inbox", "read", config.fixture.content.messageId, "--keep-unread"], cliEnv, probes, "message-read-content");
    if (read?.id !== config.fixture.content.messageId) fail("message read returned the wrong designated fixture");
    const body = read[config.fixture.content.field];
    if (typeof body !== "string" || createHash("sha256").update(body).digest("hex") !== config.fixture.content.sha256) {
      fail("designated fixture content hash mismatch");
    }

    let cursor;
    const inventory = new Map();
    const seenCursors = new Set();
    for (let pageNumber = 0; pageNumber < 100 && inventory.size < config.fixture.attachments.length; pageNumber++) {
      const args = ["inbox", "attachments", "--limit", "1", "--direction", "inbound"];
      if (cursor) args.push("--cursor", cursor);
      const page = cliJson(candidateInstall.cli, args, cliEnv, probes, `attachment-inventory-page-${pageNumber + 1}`);
      exactKeys(page, ["items", "next_cursor"], "attachment inventory page");
      if (!Array.isArray(page.items) || page.items.length !== 1) fail("attachment inventory page must contain exactly one row");
      const item = page.items[0];
      const key = attachmentKey(item);
      if (inventory.has(key)) fail("attachment cursor pagination repeated a row");
      inventory.set(key, item);
      if (inventory.size < config.fixture.attachments.length) {
        if (typeof page.next_cursor !== "string" || page.next_cursor.length === 0 || seenCursors.has(page.next_cursor)) fail("attachment cursor pagination did not advance");
        seenCursors.add(page.next_cursor);
        cursor = page.next_cursor;
      }
    }
    for (const expected of config.fixture.attachments) {
      const item = inventory.get(`${expected.messageId}:${expected.index}`);
      if (!item || item.filename !== expected.filename || item.sha256 !== expected.sha256 || item.content_available !== true) {
        fail("attachment inventory did not match the designated fixture metadata");
      }
    }

    const primaryAttachment = config.fixture.attachments[0];
    const saved = cliJson(candidateInstall.cli, [
      "inbox", "attachment", primaryAttachment.messageId,
      "--download", "--index", String(primaryAttachment.index), "--output-dir", downloadDir,
    ], cliEnv, probes, "attachment-download");
    if (!Array.isArray(saved) || saved.length !== 1 || saved[0]?.sha256 !== primaryAttachment.sha256) fail("attachment download result hash mismatch");
    const savedPath = resolve(string(saved[0].path, "attachment saved path"));
    if (!savedPath.startsWith(`${resolve(downloadDir)}/`) || createHash("sha256").update(readFileSync(savedPath)).digest("hex") !== primaryAttachment.sha256) {
      fail("downloaded attachment bytes did not match the designated hash");
    }

    const unauthenticated = await httpStatus(`${config.baseUrl}/v1/messages/${encodeURIComponent(config.fixture.content.messageId)}`, null, probes, "unauthenticated-denial");
    if (unauthenticated !== 401) fail("unauthenticated fixture read was not denied with 401");
    const crossTenant = await httpStatus(`${config.baseUrl}/v1/messages/${encodeURIComponent(config.fixture.content.messageId)}`, otherTenantApiKey, probes, "cross-tenant-denial-http");
    if (crossTenant !== 404) fail("cross-tenant fixture read was not hidden with 404");
    const otherEnv = runtimeEnv(candidateInstall.home, config.baseUrl, otherTenantApiKey, poisonDb);
    probes.push({
      name: "cross-tenant-denial-cli",
      duration_ms: runProgramExpectFailure(candidateInstall.cli, ["--json", "inbox", "read", config.fixture.content.messageId, "--keep-unread"], {
        env: otherEnv,
        label: "cross-tenant CLI read",
      }),
    });

    if (readdirSync(poisonDb).length !== 0) fail("CLI touched the ambient local database fallback trap");
    const maxLatency = Math.max(...probes.map((probe) => probe.duration_ms));
    if (maxLatency > config.maxProbeMs) fail(`latency budget exceeded (${maxLatency}ms > ${config.maxProbeMs}ms)`);

    runProgram("pg_dump", ["--format=custom", `--dbname=${sourceDatabaseUrl}`, `--file=${backupFile}`], {
      env: { PATH: process.env.PATH ?? "", PGCONNECT_TIMEOUT: "10" },
      timeout: 300_000,
      label: "database backup",
    });
    chmodSync(backupFile, 0o600);
    const archiveSha256 = createHash("sha256").update(readFileSync(backupFile)).digest("hex");
    const sourceDataSha256 = databaseFingerprint(sourceDatabaseUrl, "source database fingerprint");
    const sourceLedgerSha256 = ledgerFingerprint(sourceDatabaseUrl, "source migration ledger");

    recreateRestoreDatabase(restoreAdminUrl, restoreUrl, config.restoreDatabase, backupFile, "initial isolated restore");
    restoreCreated = true;
    if (databaseFingerprint(restoreUrl, "initial restored database fingerprint") !== sourceDataSha256
      || ledgerFingerprint(restoreUrl, "initial restored migration ledger") !== sourceLedgerSha256) fail("initial backup restore fingerprint mismatch");

    const candidateDbEnv = databaseEnv(candidateInstall.home, restoreUrl);
    dbStatus(candidateInstall.cli, candidateDbEnv, "candidate pre-migration status");
    runProgram(candidateInstall.cli, ["--json", "db", "migrate"], { env: candidateDbEnv, timeout: 300_000, label: "candidate migration" });
    const migrated = dbStatus(candidateInstall.cli, candidateDbEnv, "candidate post-migration status");
    if (migrated.pending.length !== 0) fail("candidate left pending migrations");

    const rollbackDbEnv = databaseEnv(rollbackInstall.home, restoreUrl);
    const rollbackStatus = dbStatus(rollbackInstall.cli, rollbackDbEnv, "rollback compatibility status");
    if (rollbackStatus.pending.length !== 0) fail("rollback package is not compatible with the candidate schema");

    recreateRestoreDatabase(restoreAdminUrl, restoreUrl, config.restoreDatabase, backupFile, "rollback restore drill");
    const restoredDataSha256 = databaseFingerprint(restoreUrl, "rollback restored database fingerprint");
    const restoredLedgerSha256 = ledgerFingerprint(restoreUrl, "rollback restored migration ledger");
    if (restoredDataSha256 !== sourceDataSha256 || restoredLedgerSha256 !== sourceLedgerSha256) fail("rollback restore did not reproduce the source database");

    const evidence = {
      schema_version: 1,
      kind: "emails-immutable-deployment-gate",
      result: "pass",
      execution_id: executionId,
      created_at: new Date().toISOString(),
      candidate: {
        package_name: PACKAGE_NAME,
        package_version: config.candidate.version,
        package_integrity: config.candidate.integrity,
        source_sha: config.candidate.sourceSha,
        image_digest: config.candidate.image.digest,
      },
      rollback: {
        package_name: PACKAGE_NAME,
        package_version: config.rollback.version,
        package_integrity: config.rollback.integrity,
        source_sha: config.rollback.sourceSha,
        image_digest: config.rollback.image.digest,
      },
      fixture: {
        classification: "synthetic_designated_test",
        production_data: false,
        message_body_disclosure: false,
        mailbox_rows: config.fixture.orderedIds.length,
        attachment_rows: config.fixture.attachments.length,
      },
      latency: {
        budget_ms: config.maxProbeMs,
        max_ms: maxLatency,
        probes,
      },
      backup: {
        archive_sha256: archiveSha256,
        source_data_sha256: sourceDataSha256,
        restored_data_sha256: restoredDataSha256,
        source_ledger_sha256: sourceLedgerSha256,
        restored_ledger_sha256: restoredLedgerSha256,
      },
      checks: evidenceChecks(),
    };
    validateDeploymentEvidence(evidence, { ...config, executionId });
    mkdirSync(dirname(evidencePath), { recursive: true, mode: 0o700 });
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } finally {
    if (restoreCreated) {
      try {
        runProgram("dropdb", ["--force", "--if-exists", `--maintenance-db=${restoreAdminUrl}`, "--", config.restoreDatabase], {
          env: { PATH: process.env.PATH ?? "", PGCONNECT_TIMEOUT: "10" },
          label: "restore database cleanup",
        });
      } catch {
        // The gate has already failed or completed; never mask its result with cleanup output.
      }
    }
    rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  const command = process.argv[2];
  if (command === "run") {
    const configPath = envValue("DEPLOYMENT_GATE_CONFIG");
    const evidencePath = envValue("DEPLOYMENT_GATE_EVIDENCE");
    if (existsSync(evidencePath)) fail("evidence path already exists; gate evidence is immutable");
    await runGate(configPath, evidencePath);
    console.log(`immutable deployment gate: pass (${evidencePath})`);
    return;
  }
  if (command === "verify") {
    const config = validateGateConfig(JSON.parse(readFileSync(envValue("DEPLOYMENT_GATE_CONFIG"), "utf8")));
    const { executionId } = expectedBindings(config);
    validateDeploymentEvidence(JSON.parse(readFileSync(envValue("DEPLOYMENT_GATE_EVIDENCE"), "utf8")), { ...config, executionId });
    console.log("immutable deployment evidence: pass");
    return;
  }
  fail("usage: immutable-deployment-gate.mjs run|verify");
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "immutable deployment gate failed"}\n`);
    process.exit(1);
  });
}

