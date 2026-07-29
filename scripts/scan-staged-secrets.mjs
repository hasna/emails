#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const diff = spawnSync("git", ["diff", "--cached", "--unified=0", "--no-color", "--diff-filter=ACMR"], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});
if (diff.status !== 0) {
  process.stderr.write("Could not inspect the staged diff for secrets.\n");
  process.exit(2);
}

const patterns = [
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["Resend API key", /\bre_[A-Za-z0-9_-]{24,}\b/],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["assigned credential", /(?:api[_-]?key|secret[_-]?key|client[_-]?secret|refresh[_-]?token|access[_-]?token)\s*[:=]\s*["'][^"'\s]{20,}["']/i],
];

let path = "unknown";
let addedLine = 0;
const findings = [];
for (const line of (diff.stdout ?? "").split("\n")) {
  if (line.startsWith("+++ b/")) {
    path = line.slice(6);
    continue;
  }
  const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
  if (hunk) {
    addedLine = Number(hunk[1]);
    continue;
  }
  if (!line.startsWith("+") || line.startsWith("+++")) continue;
  const content = line.slice(1);
  for (const [label, pattern] of patterns) {
    if (pattern.test(content)) findings.push(`${path}:${addedLine}: ${label}`);
  }
  addedLine += 1;
}

if (findings.length > 0) {
  // Never echo the matching line; a safety tool must not become a secret log.
  process.stderr.write(`Refusing staged credential material:\n${findings.join("\n")}\n`);
  process.exit(1);
}
