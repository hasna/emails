// Strip local `file:` workspace dependencies from package.json before a
// production container install.
//
// The runtime image runs ONLY the HTTP service (`emails-serve`) and the
// one-shot schema migration (`emails db migrate`). Neither imports the
// workspace-local packages that are wired in via `file:` paths (e.g. the MCP
// harness, which is loaded lazily and only by the `emails mcp` command). Those
// paths do not exist inside the Docker build context, so `bun install` cannot
// resolve them and the whole build fails. Removing them here keeps the image
// buildable while leaving every published (registry) dependency intact.

import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2] ?? "package.json";
const pkg = JSON.parse(readFileSync(path, "utf8"));

const sections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const removed = [];

for (const section of sections) {
  const deps = pkg[section];
  if (!deps || typeof deps !== "object") continue;
  for (const name of Object.keys(deps)) {
    if (String(deps[name]).startsWith("file:")) {
      removed.push(`${section}:${name}`);
      delete deps[name];
    }
  }
}

writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(removed.length ? `pruned file: deps -> ${removed.join(", ")}` : "no file: deps to prune");
