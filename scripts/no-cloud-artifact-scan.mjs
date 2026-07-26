#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { hostedControlPlaneFindings } from "./no-cloud-scan-lib.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// A real packed artifact currently carries ~700 files. The historical vacuous run
// — `bun pm pack` with no built `dist/` — carried 6 entries, scanned 5 files that
// held zero product code, and still printed a clean bill of health. Keep this
// floor far above that so a content-free tarball can never be certified again.
const MINIMUM_SCANNED_FILES = 100;

// Known-binary payloads (tree-sitter grammars today). Everything else is scanned,
// including extensionless files such as LICENSE and any .map/.txt/.scm sidecar.
const binaryExtensions = new Set([
  ".bin", ".br", ".dll", ".dylib", ".eot", ".exe", ".gif", ".gz", ".ico", ".jpeg", ".jpg",
  ".mp3", ".mp4", ".node", ".otf", ".pdf", ".png", ".so", ".tgz", ".ttf", ".wasm", ".wav",
  ".webp", ".woff", ".woff2", ".zip",
]);

/**
 * Every path the manifest promises consumers, derived from package.json so the
 * guard cannot go stale when entry points move. `bun pm pack --ignore-scripts`
 * skips `prepack` — which is what invokes this script, so running it would
 * recurse — meaning nothing in the pack step builds `dist/`. Asserting these
 * paths exist inside the extracted tarball is what makes an empty artifact fail.
 */
function requiredPackedEntries(pkg) {
  const required = new Set();
  const add = (value) => {
    if (typeof value !== "string") return;
    const normalized = value.replace(/^\.\//, "");
    // Globs cannot be existence-checked; the manifest uses plain paths today.
    if (normalized.length > 0 && !/[*?[\]{}]/.test(normalized)) required.add(normalized);
  };
  for (const entry of pkg.files ?? []) add(entry);
  for (const target of Object.values(pkg.bin ?? {})) add(target);
  for (const conditions of Object.values(pkg.exports ?? {})) {
    if (typeof conditions === "string") add(conditions);
    else for (const target of Object.values(conditions ?? {})) add(target);
  }
  return [...required].sort();
}

function files(path) {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) return [];
  return readdirSync(path).flatMap((entry) => files(join(path, entry)));
}

const tempRoot = mkdtempSync(join(tmpdir(), "emails-pack-scan-"));
const packDir = join(tempRoot, "pack");
const extractDir = join(tempRoot, "extract");
mkdirSync(packDir);
mkdirSync(extractDir);

const tarName = "emails-package.tgz";
execFileSync("bun", ["pm", "pack", "--ignore-scripts", "--filename", join(packDir, tarName), "--quiet"], {
  cwd: root,
  stdio: "ignore",
});
const tarball = join(packDir, tarName);

try {
  execFileSync("tar", ["-xzf", tarball, "-C", extractDir], { stdio: "ignore" });
  const packageDir = join(extractDir, "package");
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));

  const missing = requiredPackedEntries(manifest).filter((entry) => !existsSync(join(packageDir, entry)));
  if (missing.length) {
    throw new Error(
      `${tarName} is not a publishable artifact — ${missing.length} manifest path(s) missing:\n` +
        `${missing.map((entry) => `  ${entry}`).join("\n")}\n` +
        "Run `bun run build` before `bun run no-cloud:pack`; scanning a dist-less tarball certifies nothing.",
    );
  }

  const packedFiles = files(packageDir);
  const findings = [];
  let skipped = 0;
  let scanned = 0;
  for (const file of packedFiles) {
    const rel = relative(packageDir, file);
    if (binaryExtensions.has(extname(file).toLowerCase())) {
      skipped += 1;
      continue;
    }
    const buffer = readFileSync(file);
    if (buffer.includes(0)) {
      skipped += 1;
      continue;
    }
    scanned += 1;
    const reasons = hostedControlPlaneFindings(buffer.toString("utf8"), rel);
    if (reasons.length) findings.push(`${rel}: ${reasons.join(", ")}`);
  }

  if (scanned <= MINIMUM_SCANNED_FILES) {
    throw new Error(
      `${tarName} scanned only ${scanned} text file(s) of ${packedFiles.length} packed file(s), below the ` +
        `${MINIMUM_SCANNED_FILES}-file floor. A pass over that little content proves nothing — ` +
        "build the package (`bun run build`) and re-run.",
    );
  }

  if (findings.length) {
    throw new Error(`hosted-control-plane markers found in package:\n${findings.join("\n")}`);
  }
  console.log(
    `${tarName} contains no hosted-control-plane markers ` +
      `(${scanned} text file(s) scanned, ${skipped} binary file(s) skipped)`,
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
