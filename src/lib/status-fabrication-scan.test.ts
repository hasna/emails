// CLASS-LEVEL regression guard: no status builder may hardcode a count.
//
// A behavioural test only covers the blocks someone remembered to seed. This
// scan fails the NEXT hardcoded zero anywhere in a status builder — including in
// a block that does not exist yet — by parsing the TypeScript AST and rejecting
// any object-literal property whose key names a count and whose value is a
// numeric literal (or whose key names a list and whose value is `[]`).
//
// Why an AST and not a regex: a regex cannot tell `total: 0` in code from
// `total: 0` in a comment or a string, and this file's own header would trip it.
//
// Precedent for source-scanning tests in this repo: src/no-cloud-boundary.test.ts
// and src/no-cloud-artifact-scan.test.ts.

import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const SRC = join(import.meta.dir, "..");

/**
 * Files that assemble or re-publish the system-status payload. Adding a new
 * status builder without registering it here fails the last test in this file.
 */
const STATUS_BUILDERS = [
  "lib/agent-context.ts",
  "lib/status-facts.ts",
  // The enumeration EVERY status count is now built on. Same reason as
  // db/self-hosted-page.ts below: a hardcoded `complete: true` here is the same lie
  // as a hardcoded `total: 0`.
  "lib/status-facts-enumeration.ts",
  "lib/status-types.ts",
  "lib/status-availability.ts",
  "lib/inbox-sync-status-format.ts",
  "mcp/resources.ts",
  "mcp/resources.local.ts",
  "mcp/resources.remote.ts",
  // The enumeration the self-hosted counts are built on: a hardcoded
  // `complete: true` there is the same lie as a hardcoded `total: 0` here — it was
  // how 3473 of 3899 production rows got published as a total.
  "db/self-hosted-page.ts",
] as const;

/**
 * Keys whose value is a MEASUREMENT. A measurement is never a literal: it comes
 * from `rows.length`, a SQL aggregate, or it is `null` with a recorded reason.
 */
const COUNT_FIELDS = new Set([
  "total",
  "active",
  "verified",
  "owned",
  "send_ready",
  "receive_ready",
  "ready_to_receive",
  "ready_addresses",
  "legacy",
  "orphaned",
  "domains_pending",
  "domains_failed",
  "addresses_pending",
  "addresses_failed",
  "bounceRate",
  "domainCount",
  "verifiedDomains",
  "unread",
  "queue_configured",
  // Claims ABOUT the measurement. `complete: true` asserts "this count is the
  // whole table", `stable: true` asserts "the paging window never moved",
  // `degraded`/`limited` assert "here is how much of this payload to trust" —
  // each must be derived, never asserted.
  "complete",
  "stable",
  "degraded",
  "limited",
  "duplicates",
]);

/** Keys whose value is an INVENTORY. An empty inventory is a claim, not an omission. */
const LIST_FIELDS = new Set([
  "usable",
  "usable_from",
  "inbound_buckets",
  "next_actions",
  "unavailable",
  "incomplete",
  "limitations",
  "failures",
]);

/**
 * Escape hatch for a value that genuinely IS a constant (e.g. a fixture in a
 * doc example). Put this comment on the same line or the line above.
 */
const ALLOW_MARKER = "status-fabrication-scan: allow";

interface Violation {
  file: string;
  line: number;
  text: string;
}

function scanFile(relative: string): Violation[] {
  const path = join(SRC, relative);
  const text = readFileSync(path, "utf8");
  const source = ts.createSourceFile(relative, text, ts.ScriptTarget.ES2022, true);
  const lines = text.split("\n");
  const violations: Violation[] = [];

  const allowed = (line: number): boolean => {
    const current = lines[line - 1] ?? "";
    const previous = lines[line - 2] ?? "";
    return current.includes(ALLOW_MARKER) || previous.includes(ALLOW_MARKER);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
      const key = node.name.text;
      const value = node.initializer;
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      const lineNumber = line + 1;

      const numericLiteral = ts.isNumericLiteral(value)
        || (ts.isPrefixUnaryExpression(value) && ts.isNumericLiteral(value.operand));
      const booleanLiteral = value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword;
      const emptyArray = ts.isArrayLiteralExpression(value) && value.elements.length === 0;

      if (COUNT_FIELDS.has(key) && (numericLiteral || booleanLiteral) && !allowed(lineNumber)) {
        violations.push({ file: relative, line: lineNumber, text: node.getText(source).slice(0, 120) });
      }
      if (LIST_FIELDS.has(key) && emptyArray && !allowed(lineNumber)) {
        violations.push({ file: relative, line: lineNumber, text: node.getText(source).slice(0, 120) });
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);
  return violations;
}

function walkSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(join(SRC, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walkSourceFiles(relative, acc);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      acc.push(relative);
    }
  }
  return acc;
}

describe("status builders never hardcode a measurement (G4)", () => {
  for (const relative of STATUS_BUILDERS) {
    it(`${relative} has no literal count or empty-inventory field`, () => {
      const violations = scanFile(relative);
      const rendered = violations.map((v) => `${v.file}:${v.line} ${v.text}`);
      expect(rendered, `hardcoded status values found — populate from a real source or use `
        + `statusUnavailable(...) so the value is null with a reason:\n${rendered.join("\n")}`).toEqual([]);
    });
  }

  // The registry is only a guard if it is complete: a new builder that skips it
  // would skip the scan entirely.
  it("registers every status-builder source file", () => {
    const candidates = [...walkSourceFiles("lib"), ...walkSourceFiles("mcp"), ...walkSourceFiles("db")]
      .filter((relative) =>
        /(^|\/)self-hosted-page\.ts$/.test(relative)
        ||
        /(^|\/)(agent-context|status-facts|status-types|status-availability|status-commands)[^/]*\.ts$/.test(relative)
        || /(^|\/)resources[^/]*\.ts$/.test(relative)
        || /(^|\/)inbox-sync-status-format\.ts$/.test(relative));
    const registered = new Set<string>(STATUS_BUILDERS);
    const unregistered = candidates
      .filter((relative) => !registered.has(relative))
      // status-commands.ts holds command registries, not measurements.
      .filter((relative) => relative !== "lib/status-commands.ts");
    expect(unregistered, "register these in STATUS_BUILDERS so the fabrication scan covers them").toEqual([]);
  });

  it("actually detects a hardcoded count (the scan is not vacuous)", () => {
    // Self-test with the exact shape of the original defect.
    const fixture = `export function build() {\n`
      + `  return {\n`
      + `    providers: { total: 0, active: 0, by_type: {} },\n`
      + `    domains: { total: 0, send_ready: 0, usable: [] },\n`
      + `    next_actions: [],\n`
      + `  };\n`
      + `}\n`;
    const source = ts.createSourceFile("fixture.ts", fixture, ts.ScriptTarget.ES2022, true);
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
        const key = node.name.text;
        const value = node.initializer;
        if (COUNT_FIELDS.has(key) && ts.isNumericLiteral(value)) found.push(key);
        if (LIST_FIELDS.has(key) && ts.isArrayLiteralExpression(value) && value.elements.length === 0) found.push(key);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
    expect(found.sort()).toEqual(["active", "next_actions", "send_ready", "total", "total", "usable"]);
  });
});
