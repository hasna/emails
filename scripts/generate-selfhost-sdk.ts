#!/usr/bin/env bun
// Regenerates the self_hosted API client from the serve's OpenAPI document.
//   bun run scripts/generate-selfhost-sdk.ts
// The output (src/selfhost.ts, exported as @hasna/mailery/selfhost) is
// committed; CI can re-run this to verify it is in sync with openapi.ts.

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSdkFromOpenApi } from "@hasna/contracts/sdk";
import { maileryCloudOpenApi } from "../src/server/cloud/openapi.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const generated = generateSdkFromOpenApi(maileryCloudOpenApi, {
  className: "MailerySelfHostClient",
  apiKeyHeader: "x-api-key",
});

const header = `// @generated from src/server/cloud/openapi.ts by scripts/generate-selfhost-sdk.ts — DO NOT EDIT.
// Regenerate: bun run scripts/generate-selfhost-sdk.ts
`;
const out = join(root, "src", "selfhost.ts");
writeFileSync(out, header + generated.code);
console.log(`wrote ${out}`);
console.log(`operations: ${generated.operations.map((o) => o.functionName).join(", ")}`);
if (generated.warnings.length) console.log(`warnings:\n  ${generated.warnings.join("\n  ")}`);
