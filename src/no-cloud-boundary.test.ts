import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { normalizeEmailsMode } from "./lib/mode.js";

const root = join(import.meta.dir, "..");
const roots = [
  ".github",
  "AGENTS.md",
  "Dockerfile",
  "Package.swift",
  "README.md",
  "Sources",
  "dashboard",
  "docker-compose.yml",
  "docs",
  "hasna.contract.json",
  "package.json",
  "sdk",
  "src",
  "web",
] as const;
const textExtensions = new Set([".css", ".html", ".js", ".json", ".md", ".mjs", ".swift", ".ts", ".tsx", ".yaml", ".yml"]);
const excluded = new Set(["src/no-cloud-boundary.test.ts", "src/no-cloud-artifact-scan.test.ts"]);

function files(path: string): string[] {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.isFile()) return textExtensions.has(extname(path)) || path.endsWith("Dockerfile") ? [path] : [];
  if (!stat.isDirectory()) return [];
  return readdirSync(path).flatMap((entry) => entry === "node_modules" || entry === "dist" ? [] : files(join(path, entry)));
}

function scannedFiles(): string[] {
  return roots.flatMap((entry) => files(join(root, entry))).filter((path) => !excluded.has(relative(root, path)));
}

function hits(pattern: RegExp): string[] {
  return scannedFiles()
    .filter((path) => pattern.test(readFileSync(path, "utf8")))
    .map((path) => relative(root, path))
    .sort();
}

function activeHits(pattern: RegExp, allowedFiles: string[] = []): string[] {
  const allowed = new Set(allowedFiles);
  return scannedFiles()
    .filter((path) => !allowed.has(relative(root, path)))
    .filter((path) => pattern.test(readFileSync(path, "utf8")))
    .map((path) => relative(root, path))
    .sort();
}

describe("no hosted control plane", () => {
  it("uses the canonical public package name and documents the remote-bind guard", () => {
    // The published name moved to @hasna/mailery (repo hasna/mailery). Typo-squat
    // variants of either brand stay banned.
    expect(hits(/@hasnaxyz\/(?:emails|mailery)/i)).toEqual([]);
    const readme = readFileSync(join(root, "README.md"), "utf8");
    expect(readme).toContain("MAILERY_ALLOW_REMOTE=1");
    expect(readme).toContain("@hasna/mailery");
  });

  it("ships exactly local and self_hosted without hosted aliases", () => {
    expect(normalizeEmailsMode("local")).toBe("local");
    expect(normalizeEmailsMode("self_hosted")).toBe("self_hosted");
    for (const value of ["cloud", "remote", "hybrid", "self-hosted", "selfhosted"]) {
      expect(() => normalizeEmailsMode(value)).toThrow();
    }
  });

  it("has no SaaS client, command, export, package bin, or fleet env loader", () => {
    expect(existsSync(join(root, "src/cli/commands/cloud.ts"))).toBe(false);
    expect(existsSync(join(root, "src/lib/mailery-cloud-client.ts"))).toBe(false);
    expect(existsSync(join(root, "src/lib/load-cloud-env.ts"))).toBe(false);
    expect(existsSync(join(root, "src/cli/commands/triage.ts"))).toBe(false);
    expect(existsSync(join(root, "src/mcp/tools/triage.ts"))).toBe(false);
    expect((pkg.exports as Record<string, unknown>)["./cloud"]).toBeUndefined();
    // Post-rename bin surface: canonical `mailery*` bins plus the `emails*`
    // aliases kept for back-compat. Both sets must be present (existing installs
    // that call `emails*` keep working; new installs get `mailery*`).
    const bins = Object.keys(pkg.bin);
    for (const name of ["mailery", "mailery-mcp", "mailery-serve"]) expect(bins).toContain(name);
    for (const name of ["emails", "emails-mcp", "emails-serve"]) expect(bins).toContain(name);
    // No OTHER (e.g. cloud/saas) bins sneak in.
    expect(new Set(bins)).toEqual(new Set([
      "mailery", "mailery-mcp", "mailery-serve",
      "emails", "emails-mcp", "emails-serve",
    ]));
  });

  it("contains no hosted endpoint, billing, credit, or private-deployment contract", () => {
    // Hosted endpoint URLs stay banned — a self-hosted install talks to its own origin.
    expect(hits(/https?:\/\/(?:[^/]*\.)?(?:mailery\.co|emails\.hasna\.xyz)/i)).toEqual([]);
    // Control-plane BILLING/CREDIT routes stay banned. This is now a private
    // multi-tenant app, so /v1/auth/login|signup and /v1/tenants are legitimate
    // surfaces and are intentionally NOT banned here (the P1/P2/P3 pivot added them).
    expect(hits(/\/(?:api\/)?v1\/(?:billing|checkout|portal|credits?)\b/i)).toEqual([]);
    // Cloud-account data fields stay banned; `tenant_id` is a legitimate per-row
    // isolation column and is intentionally allowed.
    expect(hits(/\b(?:cloud_api_url|cloud_session_token|cloud_api_key|stripe_customer_id|credit_balance)\b/i)).toEqual([]);
    expect(hits(/\/api\/triage\b|register_agent|list_triaged|triage_stats|delete_triage/i)).toEqual([]);
    expect(hits(/\bhasna-xyz\b|\/hasna\/deploy\/|789877399345/i)).toEqual([]);
  });

  it("does not encode a removed mode in runtime or deployment configuration", () => {
    // Shipped config/source must not hardcode a removed cloud/remote/hybrid mode
    // value. (Rejection of MAILERY_MODE=cloud at runtime is covered by the mode
    // resolver tests; test files deliberately set it to prove that rejection, so
    // this static scan intentionally stays scoped to the EMAILS_ prefix.)
    expect(hits(/(?:EMAILS|HASNA_EMAILS)_(?:STORAGE_)?MODE\s*[:=]\s*["']?(?:cloud|remote|hybrid)\b/i)).toEqual([]);
  });

  it("does not ship cloud AI provider clients or model-service credentials", () => {
    expect(activeHits(/@ai-sdk\/(?:cerebras|groq)|\b(?:GROQ|CEREBRAS)_API_KEY\b|\b(?:groq|cerebras)_api_key\b|api\.cerebras\.ai|api\.groq\.com/i)).toEqual([]);
  });
});
