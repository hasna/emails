import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const PRIVATE_PLATFORM_PATTERNS = [
  /@hasna\/cloud\b/,
  new RegExp(`${["@hasna", "tools"].join("")}\\b`),
  new RegExp(`${["platform", "mailery"].join("-")}\\b`),
  /@hasna\/wallets\b/,
  new RegExp(`\\b${["open", "cloud"].join("-")}\\b`),
  new RegExp(`\\b${["cloud", "mcp"].join("-")}\\b`),
  new RegExp(`\\b${["cloud", "tool"].join("-")}\\b`),
  new RegExp(`\\b${["STRIPE", "SECRET", "KEY"].join("_")}\\b`),
  new RegExp(`\\b${["STRIPE", "WEBHOOK", "SECRET"].join("_")}\\b`),
  new RegExp(`\\b${["MAILERY", "ADMIN", "API", "KEY"].join("_")}\\b`),
  new RegExp(`${["HASNA", "CLOUD", ""].join("_")}`),
  new RegExp(`${["HASNA", "RDS"].join("_")}`),
  new RegExp(`\\b${["rds", "cluster"].join("_")}\\b`, "i"),
  new RegExp(`${["hasna", "xyz"].join("-")}`, "i"),
  new RegExp(`${["hasna", "xyz"].join("/")}`, "i"),
  new RegExp(`${["hasna", "studio"].join("-")}`, "i"),
  new RegExp(`${["hasna", "studio"].join("")}`, "i"),
  new RegExp(`${["HASNA", "XYZ", ""].join("_")}`, "i"),
  new RegExp(`${["apps", "prod", "postgres"].join("-")}`, "i"),
  new RegExp(`${["mailery", "postgres"].join("-")}`, "i"),
  new RegExp(`${["mailery", "email", "archive"].join("-")}`, "i"),
  new RegExp(`${["mailery", "archive"].join("-")}`, "i"),
  new RegExp(`${["mailery", "self-hosted"].join("/")}`, "i"),
  new RegExp(`${["mailery", "self-hosted", "postgres"].join("-")}`, "i"),
  new RegExp(`${["mailery", "self-hosted", "emails", "prod"].join("/")}`, "i"),
] as const;

const SOURCE_ROOTS = [
  "AGENTS.md",
  "Package.swift",
  "README.md",
  "Sources",
  "dashboard",
  "docs",
  "scripts",
  "sdk",
  "src",
  "web",
] as const;

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".sh",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const ACTIVE_OSS_SURFACE_FILES = [
  "README.md",
  "docs/DOMAIN_READINESS.md",
  "docs/SELF_HOSTED_RUNTIME.md",
  "src/server/index.ts",
] as const;

const UNSUPPORTED_OSS_MODE_PATTERNS = [
  /\bMailery Cloud\b/i,
  /\bemails cloud\b/i,
  /local\/self-hosted\/cloud/i,
  /\bcloud mode\b/i,
  /\bhybrid\b/i,
  /\blocal cache\b/i,
  /\bruntime cache\b/i,
] as const;

function extension(path: string): string {
  const index = path.lastIndexOf(".");
  return index >= 0 ? path.slice(index) : "";
}

function collectFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.isFile()) return TEXT_EXTENSIONS.has(extension(path)) ? [path] : [];
  if (!stat.isDirectory()) return [];

  const files: string[] = [];
  for (const entry of readdirSync(path)) {
    if (entry === "dist" || entry === "node_modules") continue;
    files.push(...collectFiles(join(path, entry)));
  }
  return files;
}

function privateCloudHits(files: string[]): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const pattern of PRIVATE_PLATFORM_PATTERNS) {
      if (pattern.test(text)) {
        hits.push(relative(root, file));
        break;
      }
    }
  }
  return hits.sort();
}

function unsupportedOssModeHits(files: string[]): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const pattern of UNSUPPORTED_OSS_MODE_PATTERNS) {
      if (pattern.test(text)) {
        hits.push(`${relative(root, file)} contains ${pattern}`);
      }
    }
  }
  return hits.sort();
}

describe("no private platform package boundary", () => {
  it("keeps package metadata and lockfiles free of private platform packages", () => {
    const files = ["package.json", "bun.lock"]
      .map((file) => join(root, file))
      .filter((file) => existsSync(file));

    expect(privateCloudHits(files)).toEqual([]);
  });

  it("keeps runtime source, SDK, and docs off private platform package names", () => {
    const files = SOURCE_ROOTS.flatMap((entry) => collectFiles(join(root, entry)));

    expect(privateCloudHits(files)).toEqual([]);
  });

  it("keeps package scripts from deleting HOME or unguarded temp paths", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    const serializedScripts = JSON.stringify(scripts);

    expect(serializedScripts).not.toContain('rm -rf "$HOME"');
    expect(serializedScripts).not.toContain("rm -rf $HOME");
    expect(scripts["prepublishOnly"]).toBe("bash scripts/prepublish-only.sh");

    const prepublish = readFileSync(join(root, "scripts", "prepublish-only.sh"), "utf8");
    expect(prepublish).toContain('tmp_home="$(mktemp -d');
    expect(prepublish).toContain('case "$tmp_home" in');
    expect(prepublish).toContain("rm -rf -- \"$tmp_home\"");
    expect(prepublish).not.toContain('rm -rf "$HOME"');
    expect(prepublish).not.toContain("rm -rf $HOME");
  });

  it("keeps package and service contract identity on Emails auth surfaces", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      name?: string;
      bin?: Record<string, string>;
    };
    expect(pkg.name).toBe("@hasna/emails");
    expect(Object.keys(pkg.bin ?? {}).sort()).toEqual(["emails", "emails-mcp", "emails-serve"]);

    const contract = JSON.parse(readFileSync(join(root, "hasna.contract.json"), "utf8")) as {
      name?: string;
      storage?: { envPrefix?: string; aliasEnvPrefix?: string };
      metadata?: { apiKeyApp?: string; apiScopes?: string[] };
    };
    expect(contract.name).toBe("emails");
    expect(contract.storage?.envPrefix).toBe("HASNA_EMAILS_");
    expect(contract.storage?.aliasEnvPrefix).toBe("EMAILS_");
    expect(contract.metadata?.apiKeyApp).toBe("emails");
    expect(contract.metadata?.apiScopes).toEqual(["emails:read", "emails:write"]);
  });

  it("keeps active OSS docs/help to local and self_hosted modes only", () => {
    const files = ACTIVE_OSS_SURFACE_FILES.map((file) => join(root, file));

    expect(unsupportedOssModeHits(files)).toEqual([]);

    const selfHostedRuntime = readFileSync(join(root, "docs", "SELF_HOSTED_RUNTIME.md"), "utf8");
    expect(selfHostedRuntime).toContain("API key");
    expect(selfHostedRuntime).toContain("CLI, MCP, and API");
    expect(selfHostedRuntime).toContain("shared cloud/Postgres deployment");
  });
});
