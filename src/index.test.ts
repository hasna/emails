import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as emails from "./index.js";

const root = join(import.meta.dir, "..");
const staticHeavyImport = /^\s*import\s+(?:[\s\S]*?\s+from\s+)?["'](?:@aws-sdk\/|@hasna\/connectors|mailparser|pg|resend|chalk|@opentui\/|react(?:\/|["']))/m;
const staticRuntimeReexport = /^\s*export\s+(?!type\b)[\s\S]*?\sfrom\s+["']([^"']+)["'];/gm;
const lazyRootModules = [
  "./lib/send.js",
  "./lib/sync.js",
  "./lib/batch.js",
  "./lib/doctor.js",
  "./lib/health.js",
  "./lib/dns-check.js",
  "./lib/email-verify.js",
  "./lib/forwarding.js",
];

function runBuild(args: string[]): void {
  const result = Bun.spawnSync({
    cmd: ["bun", "build", ...args],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`bun build failed (${args.join(" ")}):\n${result.stdout.toString()}\n${result.stderr.toString()}`);
  }
}

describe("public package entrypoint", () => {
  it("exports the documented library API surface", () => {
    for (const name of [
      "sendWithFailover",
      "createProvider",
      "listProviders",
      "listProviderSummaries",
      "createDomain",
      "listDomains",
      "createAddress",
      "listInboundEmails",
      "listInboundEmailSummaries",
      "getInboundEmailSummary",
      "getInboundAttachmentPaths",
      "setInboundReadSummary",
      "setInboundArchivedSummary",
      "setInboundStarredSummary",
      "addInboundLabelSummary",
      "removeInboundLabelSummary",
      "listReplySummaries",
      "getReceivedInboundCount",
      "getLatestReceivedInboundAt",
      "storeInboundEmail",
      "createTemplate",
      "listTemplateSummaries",
      "renderTemplate",
      "upsertContact",
      "suppressContact",
      "createSequence",
      "addStep",
      "enroll",
      "getMember",
      "listMemberSummaries",
      "getEvent",
      "listEventSummaries",
      "exportEmailsJson",
      "exportEventsCsv",
      "createOwner",
      "setAddressOwnerByRef",
      "createSendKey",
      "listSendKeySummaries",
      "listSendKeySummariesByOwners",
      "assertSendAuthorized",
      "createForwardingRule",
      "listForwardingRules",
      "processForwardingRules",
      "extractEmailLinks",
      "formatEmailLinks",
      "decodeAttachmentPayload",
      "normalizeAttachmentByteLimit",
      "validateAttachmentFilename",
      "writeAttachmentFile",
      "getInboundAttachmentStorageConfig",
      "listSandboxEmailSummaries",
      "listScheduledEmailSummaries",
      "getDatabase",
      "closeDatabase",
      "resetDatabase",
      "runInTransaction",
      "resolvePartialId",
      // Pairs with the exported `getAdapter` + `formatDnsTable`: without it a
      // consumer can produce records and cannot build the descriptor that says
      // whether an empty list means "nothing to publish" or "nothing came back".
      "providerDnsPublishing",
    ]) {
      expect(typeof (emails as Record<string, unknown>)[name]).toBe("function");
    }
    // Same round trip a consumer makes, proving the two exports compose.
    expect(
      emails.formatDnsTable([], emails.providerDnsPublishing({ type: "sandbox" } as Parameters<typeof emails.providerDnsPublishing>[0])),
    ).toContain("none are expected");
    expect(emails.CANONICAL_OPEN_EMAILS_S3_BUCKET).toBeNull();
    for (const storageInternal of ["PG_MIGRATIONS", "PgAdapterAsync", "storagePush", "storagePull", "storageSync"]) {
      expect((emails as Record<string, unknown>)[storageInternal]).toBeUndefined();
    }
  });

  it("exposes Emails mode and first-class local SQLite helpers from the storage subpath", async () => {
    const storage = await import("./storage.js");

    expect(typeof storage.getEmailsMode).toBe("function");
    expect(typeof storage.resolveEmailsMode).toBe("function");
    expect(typeof storage.normalizeEmailsMode).toBe("function");
    expect(typeof storage.labelForEmailsMode).toBe("function");
    expect(typeof storage.getDatabase).toBe("function");
    expect(typeof storage.closeDatabase).toBe("function");
    expect(typeof storage.resetDatabase).toBe("function");
    expect(typeof storage.runInTransaction).toBe("function");
    expect(typeof storage.resolvePartialId).toBe("function");

    // The self-hosted PostgreSQL/S3 mirror surface is gone; the storage subpath
    // must not resurrect any of the removed sync internals.
    for (const removed of ["PG_MIGRATIONS", "PgAdapterAsync", "getStorageStatus", "storagePush", "storagePull", "storageSync"]) {
      expect((storage as Record<string, unknown>)[removed]).toBeUndefined();
    }
  });

  it("supports an isolated local SQLite lifecycle through the public root", async () => {
    emails.closeDatabase();
    const db = emails.getDatabase(":memory:");
    const savedClientEnv = new Map(
      ["EMAILS_MODE", "EMAILS_SELF_HOSTED_URL", "EMAILS_SELF_HOSTED_API_KEY", "EMAILS_SESSION_TOKEN"]
        .map((key) => [key, process.env[key]] as const),
    );
    try {
      process.env["EMAILS_MODE"] = "self_hosted";
      delete process.env["EMAILS_SELF_HOSTED_URL"];
      delete process.env["EMAILS_SELF_HOSTED_API_KEY"];
      delete process.env["EMAILS_SESSION_TOKEN"];

      const provider = emails.runInTransaction(db, () =>
        emails.createProvider({ name: "library-local", type: "sandbox" }, db));
      const group = await emails.createGroup("library-group", undefined, db);
      const domain = emails.createDomain(provider.id, "library.example.test", db);
      const address = emails.createAddress({ provider_id: provider.id, email: "sender@library.example.test" }, db);
      expect(emails.resolvePartialId(db, "providers", provider.id.slice(0, 12))).toBe(provider.id);
      expect(emails.resolvePartialId(db, "domains", domain.id.slice(0, 12))).toBe(domain.id);
      expect(emails.resolvePartialId(db, "addresses", address.id.slice(0, 12))).toBe(address.id);
      expect(emails.listPartialIdMatches(db, "domains", domain.id.slice(0, 8))).toEqual([domain.id]);
      expect(emails.listPartialIdMatches(db, "addresses", address.id.slice(0, 8))).toEqual([address.id]);

      // Switch the singleton to a separate database. Passing `db` must still
      // address the caller-owned database rather than silently using global state.
      emails.resetDatabase();
      emails.getDatabase(":memory:");
      expect(emails.listProviders(db).map((item) => item.id)).toContain(provider.id);
      // The DATABASE-FIRST argument order is the one the local arm published for the
      // package's whole 1.x life; it must keep compiling and keep addressing `db`.
      expect((await emails.listGroups(db)).map((item) => item.id)).toContain(group.id);
    } finally {
      for (const [key, value] of savedClientEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      emails.closeDatabase();
      db.close();
    }
  });

  it("emits consumer declarations with optional Database injection", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-local-types-"));
    const typesDir = join(dir, "types");
    try {
      const emit = Bun.spawnSync({
        cmd: ["bun", "x", "tsc", "--emitDeclarationOnly", "--outDir", typesDir],
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(emit.exitCode, emit.stderr.toString()).toBe(0);

      writeFileSync(join(dir, "consumer.ts"), `
import type { Database } from "bun:sqlite";
import {
  closeDatabase,
  createProvider,
  createGroup,
  getDatabase,
  getEmail,
  listGroups,
  listProviders,
  resolvePartialId,
  runInTransaction,
} from "./types/index.js";
import { createSqliteEmailStore, getDatabase as getStorageDatabase } from "./types/storage.js";
import type { EmailStore } from "./types/storage.js";

const db: Database = getDatabase(":memory:");
const same: Database = getStorageDatabase(":memory:");
createProvider({ name: "typed", type: "sandbox" }, db);
createGroup("typed-group", undefined, db);
listGroups(db, { limit: 1 });
listProviders(db, { limit: 1 });
resolvePartialId(db, "providers", "abc");
runInTransaction(db, () => same);
// THE SENT LEDGER WIDENED THIS PARAMETER RATHER THAN REPLACING IT. \`getEmail\` is ASYNC
// now and takes an OPTIONAL store that may be an \`EmailStore\` (new) or the \`Database\`
// this surface has published for its whole 1.x life (unchanged). All THREE shapes compile,
// and the database arm is the one a released consumer already depends on.
const store: EmailStore = createSqliteEmailStore();
const byId: Promise<unknown> = getEmail("message-id");
const byStore: Promise<unknown> = getEmail("message-id", store);
const byDatabase: Promise<unknown> = getEmail("message-id", db);
void byId;
void byStore;
void byDatabase;
closeDatabase();
`);
      const typecheck = (file: string) => Bun.spawnSync({
        cmd: [
          "bun", "x", "tsc", "--noEmit", "--ignoreConfig", "--strict", "--skipLibCheck",
          "--target", "esnext", "--module", "esnext", "--moduleResolution", "bundler",
          "--types", "bun-types", join(dir, file),
        ],
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const check = typecheck("consumer.ts");
      expect(check.exitCode, `${check.stdout.toString()}\n${check.stderr.toString()}`).toBe(0);

      // THE NEGATIVE CONTROL, and it is the half that makes the positive one mean anything.
      // The store parameter is a UNION of two real shapes now, and a union is exactly the
      // declaration most likely to rot into `any` — at which point the fixture above would
      // keep passing while the surface accepted anything at all. A third, unrelated type must
      // still be a COMPILE error.
      writeFileSync(join(dir, "consumer-wrong-store.ts"), `
import { getEmail } from "./types/index.js";

void getEmail("message-id", 42 as unknown as string);
`);
      const refused = typecheck("consumer-wrong-store.ts");
      expect(refused.exitCode, "handing getEmail a string must not typecheck").not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // The budget covers three child `tsc` processes whose wall-clock scales
    // with machine load, not with the contract: 30 s was measured 7 s short
    // under a full parallel suite run on an idle arm64 box. A genuine hang
    // still fails.
  }, 180_000);

  it("keeps build outputs lean by externalizing installed runtime packages", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    const buildCommands = [
      scripts["build:cli"] ?? "",
      scripts["build:mcp"] ?? "",
      scripts["build:server"] ?? "",
      scripts["build:lib"] ?? "",
    ].filter((command) => command.includes("bun build"));
    const tuiRuntimeBuild = scripts["build:tui-runtime"] ?? "";

    // pg-migrations was removed with the self-hosted PostgreSQL mirror subsystem.
    expect(scripts["build:pg-migrations"]).toBeUndefined();
    expect(buildCommands).toHaveLength(4);
    expect(buildCommands.every((command) => command.includes("--packages external"))).toBe(true);
    expect(buildCommands.every((command) => command.includes("--splitting"))).toBe(true);
    expect(tuiRuntimeBuild).toContain("scripts/build-tui-runtime.ts");
  });

  it("keeps operational root APIs behind lazy implementation imports", () => {
    const source = readFileSync(join(root, "src/index.ts"), "utf8");
    const offenders = [...source.matchAll(staticRuntimeReexport)]
      .map((match) => match[1] ?? "")
      .filter((specifier) => lazyRootModules.includes(specifier));

    expect(offenders).toEqual([]);
    for (const specifier of lazyRootModules) {
      expect(source).toContain(`await import("${specifier}")`);
    }
  });

  it("keeps packaged entry artifacts free of static heavy-package imports", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-entry-build-"));
    try {
      const cliDir = join(dir, "cli");
      const rootDir = join(dir, "root");

      runBuild(["src/cli/index.tsx", "--outdir", cliDir, "--target", "bun", "--packages", "external", "--splitting"]);
      runBuild(["src/index.ts", "src/storage.ts", "--outdir", rootDir, "--target", "bun", "--packages", "external", "--splitting"]);

      const rootEntry = readFileSync(join(rootDir, "index.js"), "utf8");
      for (const entry of [join(cliDir, "index.js"), join(rootDir, "index.js")]) {
        expect(readFileSync(entry, "utf8")).not.toMatch(staticHeavyImport);
      }
      expect(rootEntry).not.toMatch(/^\s*import\s+[\s\S]*?\s+from\s+["']chalk["'];/m);
      for (const storageInternal of ["PG_MIGRATIONS", "PgAdapterAsync", "storagePush", "storagePull", "storageSync"]) {
        expect(rootEntry).not.toContain(storageInternal);
      }
      const storageEntry = readFileSync(join(rootDir, "storage.js"), "utf8");
      expect(storageEntry).toContain("labelForEmailsMode");
      expect(storageEntry).not.toContain("var PG_MIGRATIONS");
      for (const removed of ["PgAdapterAsync", "storagePush", "storagePull", "storageSync"]) {
        expect(storageEntry).not.toContain(removed);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
