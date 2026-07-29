import { basename } from "node:path";

export const DEPLOYMENT_GATE_COMMAND = "bun scripts/immutable-deployment-gate.mjs run";

export const REQUIRED_GATE_ENV = Object.freeze([
  "DEPLOYMENT_GATE_CONFIG",
  "DEPLOYMENT_GATE_EVIDENCE",
  "DEPLOYMENT_GATE_EXECUTION_ID",
  "DEPLOYMENT_GATE_CANDIDATE_SHA",
  "DEPLOYMENT_GATE_PACKAGE_VERSION",
  "DEPLOYMENT_GATE_PACKAGE_INTEGRITY",
  "DEPLOYMENT_GATE_IMAGE_REFERENCE",
  "DEPLOYMENT_GATE_ROLLBACK_SHA",
  "DEPLOYMENT_GATE_ROLLBACK_PACKAGE_VERSION",
  "DEPLOYMENT_GATE_ROLLBACK_PACKAGE_INTEGRITY",
  "DEPLOYMENT_GATE_ROLLBACK_IMAGE_REFERENCE",
  "EMAILS_GATE_API_KEY",
  "EMAILS_GATE_OTHER_TENANT_API_KEY",
  "EMAILS_GATE_DATABASE_URL",
  "EMAILS_GATE_RESTORE_ADMIN_URL",
  "EMAILS_GATE_RESTORE_URL",
]);

const DEPLOYMENT_FILE = /(?:^|[-_.])(deploy|deployment|publish|release)(?:[-_.]|$)/i;
const DEPLOYMENT_MUTATION = [
  /\b(?:npm|bun|pnpm|yarn)\s+publish\b/i,
  /\b(?:npm|bun|pnpm|yarn)\s+(?:run\s+)?(?:deploy|release)\b/i,
  /\bdocker\s+(?:image\s+)?push\b/i,
  /\bdocker\s+buildx\s+build\b[^\n]*\s--push\b/i,
  /\baws\s+ecs\s+(?:update-service|register-task-definition)\b/i,
  /\baws\s+cloudformation\s+deploy\b/i,
  /\b(?:terraform|tofu)\s+apply\b/i,
  /\bhelm\s+(?:install|upgrade)\b/i,
  /\bkubectl\s+(?:apply|create|replace|set\s+image|rollout)\b/i,
  /\bgh\s+release\s+create\b/i,
  /uses:\s*[^\s]*(?:deploy|publish|release)[^\s]*@/i,
];

function jobBlocks(workflow) {
  const starts = [...workflow.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm)]
    .map((match) => ({ id: match[1], start: match.index ?? 0 }))
    .filter((entry) => entry.id !== "on");
  return starts.map((entry, index) => ({
    ...entry,
    end: starts[index + 1]?.start ?? workflow.length,
    text: workflow.slice(entry.start, starts[index + 1]?.start ?? workflow.length),
  }));
}

function mutationOffsets(text) {
  const offsets = [];
  for (const pattern of DEPLOYMENT_MUTATION) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    for (const match of text.matchAll(new RegExp(pattern.source, flags))) offsets.push(match.index ?? 0);
  }
  return offsets.sort((left, right) => left - right);
}

function dependsOnGate(block) {
  return /^    needs:\s*immutable-deployment-gate\s*$/m.test(block)
    || /^    needs:\s*\[[^\]]*\bimmutable-deployment-gate\b[^\]]*\]\s*$/m.test(block);
}

/**
 * Static repository policy for any present or future publishing/deployment workflow.
 * A mutating job either runs the gate before its first mutation, or has a hard
 * dependency on the canonical gate job. GitHub skips a normal `needs` consumer when
 * the dependency fails, so `always()` and continue-on-error are deliberately banned.
 */
export function deploymentWorkflowFindings(path, workflow) {
  const blocks = jobBlocks(workflow);
  const mutations = mutationOffsets(workflow);
  const deploymentNamed = DEPLOYMENT_FILE.test(basename(path));
  if (!deploymentNamed && mutations.length === 0) return [];

  const findings = [];
  const gateBlocks = blocks.filter((block) => block.text.includes(DEPLOYMENT_GATE_COMMAND));
  if (gateBlocks.length !== 1 || gateBlocks[0]?.id !== "immutable-deployment-gate") {
    findings.push("workflow must contain exactly one immutable-deployment-gate job running the canonical gate command");
  }

  const gate = gateBlocks[0];
  if (gate) {
    for (const name of REQUIRED_GATE_ENV) {
      if (!gate.text.includes(`${name}:`)) findings.push(`gate job is missing ${name}`);
    }
    if (/continue-on-error:\s*true/i.test(gate.text)) {
      findings.push("gate job may not continue on error");
    }
    if (/\|\|\s*true\b|set\s+\+e\b/.test(gate.text)) {
      findings.push("gate command may not suppress a nonzero exit");
    }
  }

  for (const block of blocks) {
    const offsets = mutationOffsets(block.text);
    if (offsets.length === 0) continue;
    const localGate = block.text.indexOf(DEPLOYMENT_GATE_COMMAND);
    const gatedInPlace = localGate >= 0 && localGate < offsets[0];
    if (!gatedInPlace && !dependsOnGate(block.text)) {
      findings.push(`mutating job ${block.id} must run the gate first or need immutable-deployment-gate`);
    }
    if (/continue-on-error:\s*true/i.test(block.text) || /if:\s*\$?\{?\{?\s*always\s*\(\s*\)/i.test(block.text)) {
      findings.push(`mutating job ${block.id} may not bypass a failed gate`);
    }
  }

  return [...new Set(findings)];
}
