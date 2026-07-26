#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { hostedControlPlaneFindings, isSkippableBinary, requiredPackedEntries } from "./no-cloud-scan-lib.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// A real packed artifact currently carries 696 text files and 8.0 MB of them. The
// historical vacuous run — `bun pm pack` with no built `dist/` — carried 6 entries,
// scanned 5 files that held zero product code, and still printed a clean bill of
// health. Two independent floors, because either alone is dodgeable: a file count
// alone is cleared by 100 empty stub files, and a byte total alone by one big file.
// The byte floor is deliberately loose — about an eighth of today's payload — so a
// bundling-strategy change cannot trip it but a stubbed `dist/` cannot clear it.
const MINIMUM_SCANNED_FILES = 100;
const MINIMUM_SCANNED_BYTES = 1_000_000;

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

// `--ignore-scripts` is required, not an oversight: `prepack` is what invokes this
// script, so letting it run would recurse. It also means nothing in the pack step
// builds `dist/` — which is exactly why the manifest assertions below exist.
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

  const required = requiredPackedEntries(manifest);
  // Guard the derivation itself: a manifest shape that yields no product payload
  // would make every assertion below vacuous.
  if (!required.some((entry) => entry === "dist" || entry.startsWith("dist/"))) {
    throw new Error(
      `package.json declares no dist/ payload in files/bin/exports (derived: ${required.join(", ") || "nothing"}). ` +
        "Without one this scan cannot tell a real artifact from an empty one.",
    );
  }

  const problems = [];
  for (const entry of required) {
    const path = join(packageDir, entry);
    if (!existsSync(path)) {
      problems.push(`${entry}: missing`);
      continue;
    }
    const stat = statSync(path);
    // Existence alone passes zero-byte stubs, which is the same "no product code"
    // state as a missing file.
    if (stat.isFile() && stat.size === 0) problems.push(`${entry}: present but empty`);
    if (stat.isDirectory() && files(path).length === 0) problems.push(`${entry}: present but contains no files`);
  }
  if (problems.length) {
    throw new Error(
      `${tarName} is not a publishable artifact — ${problems.length} manifest path problem(s):\n` +
        `${problems.map((problem) => `  ${problem}`).join("\n")}\n` +
        "Run `bun run build` before `bun run no-cloud:pack`; scanning a dist-less tarball certifies nothing.",
    );
  }

  const packedFiles = files(packageDir);
  const findings = [];
  const skipped = [];
  let scanned = 0;
  let scannedBytes = 0;
  for (const file of packedFiles) {
    const rel = relative(packageDir, file);
    const buffer = readFileSync(file);
    // Every file is READ. A skip needs a binary extension AND binary bytes, so a
    // plaintext payload named `hosted.br` is scanned instead of waved through.
    if (isSkippableBinary(rel, buffer)) {
      skipped.push(rel);
      continue;
    }
    scanned += 1;
    scannedBytes += buffer.length;
    // latin1, never utf8: it cannot throw and preserves every ASCII byte, so a stray
    // NUL or invalid sequence in a bundle chunk cannot make that chunk unscannable.
    const reasons = hostedControlPlaneFindings(buffer.toString("latin1"), rel);
    if (reasons.length) findings.push(`${rel}: ${reasons.join(", ")}`);
  }

  if (scanned < MINIMUM_SCANNED_FILES || scannedBytes < MINIMUM_SCANNED_BYTES) {
    throw new Error(
      `${tarName} is too small to certify: scanned ${scanned} text file(s) (floor ${MINIMUM_SCANNED_FILES}) ` +
        `totalling ${scannedBytes} byte(s) (floor ${MINIMUM_SCANNED_BYTES}) across ${packedFiles.length} packed file(s). ` +
        "A pass over that little content proves nothing.",
    );
  }

  if (findings.length) {
    throw new Error(`hosted-control-plane markers found in package:\n${findings.join("\n")}`);
  }
  const skippedExtensions = [...new Set(skipped.map((path) => extname(path).toLowerCase()))].sort();
  console.log(
    `${tarName} contains no hosted-control-plane markers ` +
      `(${scanned} text file(s), ${scannedBytes} bytes scanned; ` +
      `${skipped.length} binary file(s) skipped${skippedExtensions.length ? `: ${skippedExtensions.join(" ")}` : ""})`,
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
