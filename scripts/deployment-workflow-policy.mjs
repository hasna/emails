#!/usr/bin/env bun
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deploymentWorkflowFindings } from "./deployment-workflow-policy-lib.mjs";

const root = join(import.meta.dir, "..");
const workflowDir = join(root, ".github", "workflows");
const failures = [];

for (const name of readdirSync(workflowDir).filter((entry) => /\.ya?ml$/.test(entry)).sort()) {
  const findings = deploymentWorkflowFindings(name, readFileSync(join(workflowDir, name), "utf8"));
  for (const finding of findings) failures.push(`${name}: ${finding}`);
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}

console.log("deployment workflow gate policy: pass");

