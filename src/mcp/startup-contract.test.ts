import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const mcpDir = import.meta.dir;
const toolsDir = join(mcpDir, "tools");

const heavyToolImports = [
  "@aws-sdk/",
  "@hasna/connectors",
  "mailparser",
  "pg",
  "../../lib/s3-sync.js",
  "../../lib/aws-inbound.js",
  "../../lib/send.js",
  "../../lib/sync.js",
  "../../lib/delivery-doctor.js",
  "../../lib/agent-context.js",
  "../../lib/address-ownership.js",
  "../../cli/tui/autopull.js",
];

const heavyEntrypointImports = [
  "./server.js",
  "./http.js",
  "@modelcontextprotocol/sdk/server/stdio.js",
];

const heavyResourceImports = [
  "../lib/agent-context.js",
  "../lib/address-ownership.js",
];

const staticImport = /^\s*import\s+(?!type\b)[\s\S]*?\sfrom\s+["']([^"']+)["'];/gm;

function toolFiles(): string[] {
  return readdirSync(toolsDir)
    .filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\.(ts|tsx)$/.test(file))
    .map((file) => join(toolsDir, file));
}

function hasDynamicImport(source: string, specifier: string): boolean {
  return source.includes(`import("${specifier}")`) || source.includes(`import('${specifier}')`);
}

describe("MCP startup contract", () => {
  it("keeps heavy provider and sync dependencies behind tool-local dynamic imports", () => {
    const offenders: string[] = [];

    for (const file of toolFiles()) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(staticImport)) {
        const specifier = match[1] ?? "";
        if (heavyToolImports.some((heavy) => specifier === heavy || specifier.startsWith(heavy))) {
          offenders.push(`${file.replace(`${toolsDir}/`, "")}: ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps provider tool implementation dependencies lazy", () => {
    const lazyToolDeps = [
      "../../db/providers.js",
      "../../providers/index.js",
      "../../lib/redaction.js",
      "../helpers.js",
    ];
    const source = readFileSync(join(toolsDir, "providers.ts"), "utf8");
    const offenders: string[] = [];

    for (const match of source.matchAll(staticImport)) {
      const specifier = match[1] ?? "";
      if (lazyToolDeps.includes(specifier)) offenders.push(specifier);
    }

    expect(offenders).toEqual([]);
    expect(source).toContain('import("./providers-impl.js")');
  });

  it("keeps domain tool implementation dependencies lazy", () => {
    const lazyToolDeps = [
      "../../db/domains.js",
      "../../db/addresses.js",
      "../../db/address-lifecycle.js",
      "../../db/aliases.js",
      "../../db/send-keys.js",
      "../../db/providers.js",
      "../../db/database.js",
      "../../providers/index.js",
      "../../db/provisioning.js",
      "../../lib/domain-readiness.js",
      "../helpers.js",
    ];
    const source = readFileSync(join(toolsDir, "domains.ts"), "utf8");
    const offenders: string[] = [];

    for (const match of source.matchAll(staticImport)) {
      const specifier = match[1] ?? "";
      if (lazyToolDeps.includes(specifier)) offenders.push(specifier);
    }

    expect(offenders).toEqual([]);
    expect(source).toContain('import("./domains-impl.js")');
  });

  it("keeps inbox tool implementation dependencies lazy", () => {
    const lazyToolDeps = [
      "../../db/inbound.js",
      "../../db/database.js",
      "../../db/pagination.js",
      "../../lib/verification-code.js",
      "../helpers.js",
    ];
    const source = readFileSync(join(toolsDir, "inbox.ts"), "utf8");
    const offenders: string[] = [];

    for (const match of source.matchAll(staticImport)) {
      const specifier = match[1] ?? "";
      if (lazyToolDeps.includes(specifier)) offenders.push(specifier);
    }

    expect(offenders).toEqual([]);
    expect(source).toContain('import("./inbox-impl.js")');
  });

  it("keeps email operation implementation dependencies lazy", () => {
    // Self-hosted-only: email ops route through the mail-data-source seam (/v1),
    // no local DB module is imported anymore.
    const lazyToolDeps = [
      "../../lib/mail-data-source.js",
      "../helpers.js",
    ];
    const source = readFileSync(join(toolsDir, "email-ops.ts"), "utf8");
    const localSource = readFileSync(join(toolsDir, "email-ops.local.ts"), "utf8");
    const remoteSource = readFileSync(join(toolsDir, "email-ops.remote.ts"), "utf8");
    const offenders: string[] = [];

    for (const match of source.matchAll(staticImport)) {
      const specifier = match[1] ?? "";
      if (lazyToolDeps.includes(specifier)) offenders.push(specifier);
    }

    expect(offenders).toEqual([]);
    expect(source).toContain('from "./email-ops.local.js"');
    expect(source).toContain('from "./email-ops.remote.js"');
    expect(hasDynamicImport(localSource, "../helpers.js")).toBe(true);
    for (const specifier of lazyToolDeps) expect(hasDynamicImport(remoteSource, specifier)).toBe(true);
  });

  it("keeps sequence implementation dependencies lazy", () => {
    // Self-hosted-only: sequences route through the /v1 resource store + mode guard.
    const lazyToolDeps = [
      "../../db/self-hosted-store.js",
      "../../db/sequences.js",
      "../../lib/mode.js",
      "../helpers.js",
    ];
    const source = readFileSync(join(toolsDir, "sequences.ts"), "utf8");
    const offenders: string[] = [];

    for (const match of source.matchAll(staticImport)) {
      const specifier = match[1] ?? "";
      if (lazyToolDeps.includes(specifier)) offenders.push(specifier);
    }

    expect(offenders).toEqual([]);
    for (const specifier of lazyToolDeps) {
      expect(hasDynamicImport(source, specifier)).toBe(true);
    }
  });

  it("keeps miscellaneous operation implementation dependencies lazy", () => {
    // Self-hosted-only: misc ops route through the /v1 resource store + mode guard;
    // the remaining heavy libs (analytics/doctor/export/email-verify) stay lazy.
    const lazyToolDeps = [
      "../../db/self-hosted-store.js",
      "../../lib/analytics.js",
      "../../lib/doctor.js",
      "../../lib/export.js",
      "../../lib/email-verify.js",
      "../../lib/mode.js",
      "../helpers.js",
    ];
    const source = readFileSync(join(toolsDir, "misc-ops.ts"), "utf8");
    const offenders: string[] = [];

    for (const match of source.matchAll(staticImport)) {
      const specifier = match[1] ?? "";
      if (lazyToolDeps.includes(specifier)) offenders.push(specifier);
    }

    expect(offenders).toEqual([]);
    for (const specifier of lazyToolDeps) {
      expect(hasDynamicImport(source, specifier)).toBe(true);
    }
  });

  it("lets help and version exit before importing the server graph", () => {
    const source = readFileSync(join(mcpDir, "index.ts"), "utf8");
    const offenders = [...source.matchAll(staticImport)]
      .map((match) => match[1] ?? "")
      .filter((specifier) => heavyEntrypointImports.includes(specifier));

    expect(offenders).toEqual([]);
    expect(source).toContain('import("./server.js")');
  });

  it("keeps stdio startup off the HTTP transport graph", () => {
    const source = readFileSync(join(mcpDir, "index.ts"), "utf8");
    const stdioCheck = source.indexOf("isStdioMode(args)");
    const httpImport = source.indexOf('import("./http.js")');

    expect(source).toContain('import("./options.js")');
    expect(stdioCheck).toBeGreaterThan(-1);
    expect(httpImport).toBeGreaterThan(stdioCheck);
  });

  it("keeps MCP HTTP health and startup off the full tool server graph", () => {
    const source = readFileSync(join(mcpDir, "http.ts"), "utf8");
    const offenders = [...source.matchAll(staticImport)]
      .map((match) => match[1] ?? "")
      .filter((specifier) => specifier === "./server.js");

    expect(offenders).toEqual([]);
    expect(source).toContain('import("./server.js")');
  });

  it("keeps expensive orientation resources lazy until a resource is read", () => {
    const source = readFileSync(join(mcpDir, "resources.ts"), "utf8");
    const offenders = [...source.matchAll(staticImport)]
      .map((match) => match[1] ?? "")
      .filter((specifier) => heavyResourceImports.includes(specifier));

    expect(offenders).toEqual([]);
  });
});
