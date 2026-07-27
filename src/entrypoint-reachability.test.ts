// Guard: every non-test source file must be reachable from a SHIPPED build
// entrypoint. This is the regression fence for the "unreachable features" class
// of rot — modules that keep passing their own unit tests while no shipped
// binary, library export, or server can ever load them.
//
// The entrypoint list is DERIVED, not hardcoded: it is read out of the
// `bun build` invocations in package.json `scripts` plus the `entrypoints:`
// array in scripts/build-tui-runtime.ts. If a build entrypoint is added or
// removed, this test follows automatically instead of going stale.
//
// Reachability follows static `from "..."` / `import "..."`, `export ... from`,
// dynamic `import("...")` and `require("...")` specifiers, so action-local lazy
// imports (the CLI startup contract mandates them) still count as reachable.
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { Glob } from "bun";

const REPO_ROOT = join(import.meta.dir, "..");
const SRC_ROOT = join(REPO_ROOT, "src");

// Files that are legitimately outside the shipped module graph. Every entry
// needs a reason; nothing else may be added without one.
const ALLOWED_UNREACHABLE: Array<{ path: string; reason: string }> = [
  { path: "src/test-support/aws-s3-mock.ts", reason: "test-only harness, imported by *.test.ts" },
  { path: "src/test-support/v1-stub.ts", reason: "test-only out-of-process /v1 stub, imported by *.test.ts" },
  { path: "src/test-support/legacy-mail-seed.ts", reason: "test-only SQL seeder for legacy tables the server still reads" },
  { path: "src/test-support/cli-refusals.ts", reason: "test-only ORACLE: parses the CLI's serverOnly()/notImplementedAnywhere() call sites so a guard can check the refusal registry against the CLI instead of against itself. Deliberately not shipped — nothing at runtime may depend on reading its own source." },
  { path: "src/test-support/mcp-http.ts", reason: "test-only MCP HTTP fixture (bearer token + guarded transport), imported by *.test.ts" },
  { path: "src/server/self-hosted/auth/test-support.ts", reason: "test-only auth deps, imported by *.test.ts" },
  { path: "src/types/domains.d.ts", reason: "ambient module declaration; consumed by tsc, not by the module graph" },
];

const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"];

function isTestFile(path: string): boolean {
  return /\.test\.(ts|tsx)$/.test(path);
}

/** Entrypoints the published package actually builds. */
function shippedEntrypoints(): string[] {
  const found = new Set<string>();

  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  for (const script of Object.values(pkg.scripts ?? {})) {
    const build = /\bbun build\s+((?:src\/[^\s]+\s+)*src\/[^\s]+)/.exec(script);
    if (!build?.[1]) continue;
    for (const entry of build[1].trim().split(/\s+/)) found.add(join(REPO_ROOT, entry));
  }

  const runtimeBuild = readFileSync(join(REPO_ROOT, "scripts", "build-tui-runtime.ts"), "utf8");
  const entrypointsBlock = /entrypoints:\s*\[([^\]]*)\]/.exec(runtimeBuild);
  for (const match of (entrypointsBlock?.[1] ?? "").matchAll(/["'`](src\/[^"'`]+)["'`]/g)) {
    found.add(join(REPO_ROOT, match[1] as string));
  }

  return [...found];
}

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return null;
  const base = specifier.startsWith("/") ? specifier : resolve(dirname(fromFile), specifier);
  const candidates: string[] = [];
  // TS emits ".js" specifiers that resolve to ".ts"/".tsx" sources.
  const jsLess = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
  if (jsLess !== base) for (const ext of RESOLVE_EXTENSIONS) candidates.push(jsLess + ext);
  candidates.push(base);
  for (const ext of RESOLVE_EXTENSIONS) candidates.push(base + ext);
  for (const ext of RESOLVE_EXTENSIONS) candidates.push(join(base, `index${ext}`));
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|(?:^|[^.\w])\bimport\s*|(?:^|[^.\w])\brequire\s*\(|(?:^|[^.\w])\bimport\s*\()\s*["'`]([^"'`]+)["'`]/g;

function localSpecifiers(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(IMPORT_SPECIFIER)].map((match) => match[1] as string);
}

function reachableFiles(): Set<string> {
  const seen = new Set<string>();
  const queue = shippedEntrypoints();
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of localSpecifiers(file)) {
      const resolved = resolveSpecifier(file, specifier);
      if (resolved && resolved.startsWith(SRC_ROOT) && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

function allSourceFiles(): string[] {
  const files: string[] = [];
  for (const pattern of ["**/*.ts", "**/*.tsx"]) {
    for (const rel of new Glob(pattern).scanSync(SRC_ROOT)) files.push(join(SRC_ROOT, rel));
  }
  return files;
}

describe("shipped entrypoint reachability", () => {
  it("derives its entrypoints from the real build scripts", () => {
    const entrypoints = shippedEntrypoints().map((file) => relative(REPO_ROOT, file)).sort();
    // The six package.json bin/exports builds plus the string-referenced TUI runtime.
    expect(entrypoints).toEqual([
      "src/cli/index.tsx",
      "src/cli/tui/runtime.tsx",
      "src/index.ts",
      "src/mcp/index.ts",
      "src/selfhost.ts",
      "src/server/index.ts",
      "src/storage.ts",
    ]);
    for (const entry of shippedEntrypoints()) expect(existsSync(entry)).toBe(true);
  });

  it("has no product code outside the shipped module graph", () => {
    const reachable = reachableFiles();
    const allowed = new Set(ALLOWED_UNREACHABLE.map((entry) => entry.path));

    const unreachable = allSourceFiles()
      .filter((file) => !reachable.has(file))
      .map((file) => relative(REPO_ROOT, file))
      .filter((file) => !isTestFile(file))
      .filter((file) => !allowed.has(file))
      .sort();

    expect(unreachable).toEqual([]);
  });

  it("keeps the unreachable allowlist honest (no stale entries)", () => {
    for (const { path } of ALLOWED_UNREACHABLE) {
      expect(existsSync(join(REPO_ROOT, path))).toBe(true);
    }
    const reachable = reachableFiles();
    for (const { path } of ALLOWED_UNREACHABLE) {
      expect(reachable.has(join(REPO_ROOT, path))).toBe(false);
    }
  });
});
