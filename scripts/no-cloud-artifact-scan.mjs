#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { hostedControlPlaneFindings } from "./no-cloud-scan-lib.mjs";

const root = process.cwd();
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

function files(path) {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) return [];
  return readdirSync(path).flatMap((entry) => files(join(path, entry)));
}

try {
  execFileSync("tar", ["-xzf", tarball, "-C", extractDir], { stdio: "ignore" });
  const packageDir = join(extractDir, "package");
  const findings = [];
  for (const file of files(packageDir)) {
    if (!/\.(?:css|html|json|js|mjs|cjs|md|ts|tsx|yaml|yml)$/.test(file)) continue;
    const rel = relative(packageDir, file);
    const content = readFileSync(file, "utf8");
    const reasons = hostedControlPlaneFindings(content, rel);
    if (reasons.length) findings.push(`${rel}: ${reasons.join(", ")}`);
  }
  if (findings.length) {
    throw new Error(`hosted-control-plane markers found in package:\n${findings.join("\n")}`);
  }
  console.log(`${tarName} contains no hosted-control-plane markers`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
