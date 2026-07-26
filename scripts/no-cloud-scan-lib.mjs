const legacyHostedEnvKeys = [
  "MAILERY_API_URL",
  "MAILERY_API_KEY",
  "MAILERY_CLOUD_API_URL",
  "MAILERY_CLOUD_TOKEN",
  "HASNA_MAILERY_API_URL",
  "HASNA_MAILERY_API_KEY",
];

/** Surface scanned by `scripts/no-cloud-artifact-scan.mjs` (the packed tarball). */
export const ARTIFACT_SCOPE = "artifact";
/** Surface scanned by `src/no-cloud-boundary.test.ts` (the committed tree). */
export const SOURCE_SCOPE = "source";
export const BOUNDARY_SCOPES = [ARTIFACT_SCOPE, SOURCE_SCOPE];
const BOTH = BOUNDARY_SCOPES;

// This is a PRIVATE, internal MULTI-TENANT app. Legitimate tenancy vocabulary
// (tenants/users/auth/memberships/sessions, `tenant_id`, /v1/auth/*, /v1/tenants)
// is ALLOWED — the deliberate P1/P2/P3 pivot added it on purpose. What must never
// ship is a HOSTED cloud control plane: hardcoded account ids / hosted endpoint
// URLs, bundled cloud-AI provider clients, and billing/credit/stripe surfaces.
//
// SINGLE DEFINITION SITE. Both boundary guards read this table, so the two ban
// lists cannot drift. Every entry MUST declare `scopes`; an entry not enforced on
// a surface MUST record why in `exemptions[scope]`, and a `sourceAllowlist` MUST
// record why in `allowlistReason`. `assertBoundaryPatternTable` enforces that at
// import time, so adding a pattern forces an explicit, reviewable decision about
// both surfaces instead of a silent one-sided edit.
//
// Weakening a REGEX is a different failure mode from weakening the table shape,
// and shape validation cannot catch it. `src/no-cloud-artifact-scan.test.ts` holds
// a positive-detection fixture for every label on both scopes, so neutering any
// pattern here fails that suite.
const boundaryPatterns = [
  { label: "hosted package", scopes: BOTH, pattern: /@hasna\/cloud\b/i },
  // Typo-squat variants of either brand. `@hasna/emails` is the published name.
  { label: "typo-squat package name", scopes: BOTH, pattern: /@hasnaxyz\/(?:emails|mailery)/i },
  { label: "hosted endpoint", scopes: BOTH, pattern: /https?:\/\/(?:[^/]*\.)?(?:mailery\.co|emails\.hasna\.xyz)/i },
  // Control-plane billing/credit routes only. Auth/login|signup and /v1/tenants
  // are legitimate self-hosted multi-tenant routes and are intentionally allowed.
  { label: "hosted billing route", scopes: BOTH, pattern: /\/(?:api\/)?v1\/(?:billing|checkout|portal|credits?)\b/i },
  // Cloud-account data fields only. `tenant_id` is a legitimate per-row isolation
  // column here and is intentionally NOT flagged.
  { label: "hosted data field", scopes: BOTH, pattern: /\b(?:cloud_api_url|cloud_session_token|cloud_api_key|stripe_customer_id|credit_balance)\b/i },
  { label: "hosted triage surface", scopes: BOTH, pattern: /\/api\/triage\b|register_agent|list_triaged|triage_stats|delete_triage/i },
  { label: "removed mode in configuration", scopes: BOTH, pattern: /(?:EMAILS|HASNA_EMAILS)_(?:STORAGE_)?MODE\s*[:=]\s*["']?(?:cloud|remote|hybrid)\b/i },
  { label: "cloud ai provider client", scopes: BOTH, pattern: /@ai-sdk\/(?:cerebras|groq)|\b(?:GROQ|CEREBRAS)_API_KEY\b|api\.cerebras\.ai|api\.groq\.com/i },
  { label: "private deployment marker", scopes: BOTH, pattern: /\bhasna-xyz\b|\/hasna\/deploy\/|789877399345/i },
  { label: "retired inbound bucket prefix", scopes: BOTH, pattern: /hasna-emails-prod-inbound/i },
  { label: "hosted camel-case identifier", scopes: BOTH, pattern: /(?:cloud|Cloud)(?:Provider|Client|Account|Tenant|Session|Api|API|Token|Credit|Billing|Fleet|Mode|Sync)[A-Za-z0-9_]*/ },
  {
    label: "legacy hosted environment",
    scopes: BOTH,
    pattern: new RegExp(legacyHostedEnvKeys.join("|"), "i"),
    // `src/lib/mode.ts` (the rejection list) and `.github/workflows/ci.yml` (`env -u`)
    // are handled by stripExactCompatibilityBridges and need no allowance. What remains
    // is the suites that assert the rejection, which must spell the variables out.
    allowlistReason:
      "These suites assert that the retired variables are REJECTED, so each has to name them as an input. " +
      "Every other source file, and every packed bundle chunk, is still checked.",
    sourceAllowlist: [
      "src/cli/cli-contract.test.ts",
      "src/cli/tui/autopull.test.ts",
      "src/db/self-hosted-store.test.ts",
      "src/lib/client-env.test.ts",
      "src/lib/doctor.test.ts",
      "src/lib/mode.test.ts",
      "src/lib/self-hosted-mail-data-source.test.ts",
      "src/mcp/domain-address-self-hosted.test.ts",
    ],
  },
  {
    label: "hosted implementation vocabulary",
    scopes: BOTH,
    pattern: /\b(?:saas|fleet)\b|cloud_/i,
    // `src/lib/mode.ts`, `src/server/self-hosted/migrations.ts` and
    // `src/server/self-hosted/service-resources.test.ts` are handled by
    // stripExactCompatibilityBridges and need no allowance.
    allowlistReason:
      "Prose describing the pivot AWAY from a hosted SaaS/fleet (CHANGELOG, docs, the deploy README, and " +
      "the Terraform comment asserting no vendor account), plus the suites that assert `MAILERY_CLOUD_*` " +
      "inputs are rejected. Every other source file, and every packed bundle chunk, is still checked.",
    sourceAllowlist: [
      "CHANGELOG.md",
      "deploy/aws/README.md",
      "deploy/aws/backend.tf",
      "docs/design/multi-tenancy-auth.md",
      "src/cli/tui/autopull.test.ts",
      "src/lib/doctor.test.ts",
      "src/lib/mode.test.ts",
      "src/lib/self-hosted-mail-data-source.test.ts",
      "src/mcp/domain-address-self-hosted.test.ts",
    ],
  },
];

function assertBoundaryPatternTable(table) {
  if (!Array.isArray(table) || table.length === 0) throw new Error("the boundary pattern table is empty");
  const seen = new Set();
  for (const entry of table) {
    const { label, pattern, scopes, exemptions = {}, sourceAllowlist = [], allowlistReason } = entry ?? {};
    if (typeof label !== "string" || label.length === 0) throw new Error("boundary pattern is missing a label");
    if (seen.has(label)) throw new Error(`duplicate boundary pattern label: ${label}`);
    seen.add(label);
    if (!(pattern instanceof RegExp)) throw new Error(`boundary pattern ${label} is not a RegExp`);
    if (!Array.isArray(scopes) || scopes.length === 0) throw new Error(`boundary pattern ${label} declares no scopes`);
    for (const scope of scopes) {
      if (!BOUNDARY_SCOPES.includes(scope)) throw new Error(`boundary pattern ${label} declares unknown scope: ${scope}`);
    }
    for (const scope of BOUNDARY_SCOPES) {
      if (scopes.includes(scope)) continue;
      if (typeof exemptions[scope] === "string" && exemptions[scope].trim().length > 0) continue;
      throw new Error(`boundary pattern ${label} is not enforced on the ${scope} surface and records no exemptions.${scope} reason`);
    }
    if (!Array.isArray(sourceAllowlist)) throw new Error(`boundary pattern ${label} has a non-array sourceAllowlist`);
    if (new Set(sourceAllowlist).size !== sourceAllowlist.length) throw new Error(`boundary pattern ${label} has a duplicate sourceAllowlist entry`);
    if (sourceAllowlist.length > 0 && !(typeof allowlistReason === "string" && allowlistReason.trim().length > 0)) {
      throw new Error(`boundary pattern ${label} allows ${sourceAllowlist.length} source file(s) and records no allowlistReason`);
    }
  }
  return table;
}

assertBoundaryPatternTable(boundaryPatterns);

/** Full table, including the scope/exemption metadata the agreement test asserts on. */
export const boundaryPatternTable = boundaryPatterns;

export function boundaryPatternsForScope(scope) {
  if (!BOUNDARY_SCOPES.includes(scope)) throw new Error(`unknown boundary scope: ${scope}`);
  return boundaryPatterns.filter((entry) => entry.scopes.includes(scope));
}

/** Patterns enforced on the packed artifact only — each carries a source-exemption reason. */
export const artifactBoundaryPatterns = boundaryPatternsForScope(ARTIFACT_SCOPE);
/** Patterns enforced on the committed source tree. */
export const sourceBoundaryPatterns = boundaryPatternsForScope(SOURCE_SCOPE);

function stripExactCompatibilityBridges(content, path) {
  let scanned = content;
  // The mode resolver must retain these literal names only to reject old
  // environments with actionable migration guidance. Do not exempt its file or
  // bundle chunk wholesale: only erase literals inside the named rejection list.
  scanned = scanned.replace(/LEGACY_HOSTED_ENV_KEYS\s*=\s*\[[\s\S]*?\]/g, (block) => {
    let safe = block;
    for (const key of legacyHostedEnvKeys) safe = safe.replaceAll(`"${key}"`, '"LEGACY_HOSTED_SENTINEL"');
    return safe;
  });

  // The Postgres bridge must keep the released table name to migrate existing
  // installations. Both migration ids are required so an unrelated occurrence
  // of the old identifier is never silently accepted.
  if (scanned.includes("0005_mailery_selfhosted_resources") && scanned.includes("0006_emails_rename_bridge")) {
    const exactReleasedSql = [
      "CREATE TABLE IF NOT EXISTS cloud_providers",
      "to_regclass('public.cloud_providers')",
      "ALTER TABLE cloud_providers RENAME TO self_hosted_providers",
      "FROM cloud_providers",
      "DROP TABLE cloud_providers",
    ];
    for (const sql of exactReleasedSql) scanned = scanned.replaceAll(sql, sql.replaceAll("cloud_providers", "legacy_providers"));
  }

  // CI explicitly unsets legacy variables to make the test environment
  // deterministic. Exempt only those `env -u NAME` tokens.
  if (path.endsWith(".github/workflows/ci.yml")) {
    for (const key of legacyHostedEnvKeys) scanned = scanned.replaceAll(`-u ${key}`, "-u LEGACY_HOSTED_SENTINEL");
  }
  return scanned;
}

/**
 * Shared scan engine. Both guards run the same stripper and the same table so a
 * finding on one surface is reproducible on the other. `path` must be repo-relative
 * (source) or package-relative (artifact) for `sourceAllowlist` to resolve.
 */
export function boundaryFindings(content, path, scope) {
  const scanned = stripExactCompatibilityBridges(content, path);
  return boundaryPatternsForScope(scope)
    .filter((entry) => !(scope === SOURCE_SCOPE && (entry.sourceAllowlist ?? []).includes(path)))
    .filter(({ pattern }) => pattern.test(scanned))
    .map(({ label }) => label);
}

export function hostedControlPlaneFindings(content, path = "artifact") {
  return boundaryFindings(content, path, ARTIFACT_SCOPE);
}

export function sourceBoundaryFindings(content, path = "source") {
  return boundaryFindings(content, path, SOURCE_SCOPE);
}

/**
 * Extensions whose payload is genuinely binary. This is a HINT, not a licence to
 * skip: `isSkippableBinary` also requires the bytes to look binary, so a plaintext
 * payload named `hosted.br` is scanned rather than waved through on its name. And
 * content alone never causes a skip — a `.js` bundle chunk with a stray NUL is
 * still scanned (decoded as latin1), because skipping on content let one NUL byte
 * hide every marker in a file.
 */
export const binaryExtensions = new Set([
  ".bin", ".br", ".dll", ".dylib", ".eot", ".exe", ".gif", ".gz", ".ico", ".jpeg", ".jpg",
  ".mp3", ".mp4", ".node", ".otf", ".pdf", ".png", ".so", ".tgz", ".ttf", ".wasm", ".wav",
  ".webp", ".woff", ".woff2", ".zip",
]);

/** True only when the extension says binary AND the bytes agree. */
export function isSkippableBinary(path, buffer) {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return binaryExtensions.has(ext) && buffer.includes(0);
}

/**
 * Every path a manifest promises consumers, derived from `files` + `bin` + `exports`
 * so the artifact guard cannot go stale when entry points move. Export conditions
 * are walked to arbitrary depth, a glob contributes its static prefix (`dist/**` ->
 * `dist`) rather than nothing, and an npm negation (`!dist/internal.js`) is dropped
 * rather than demanded. A shape that silently produced an EMPTY required set would
 * hand back the vacuity this guard exists to remove, so the caller must also reject
 * a result with no product payload in it.
 */
export function requiredPackedEntries(pkg) {
  const required = new Set();
  const add = (value) => {
    if (value.startsWith("!")) return;
    let normalized = value.replace(/^\.\//, "");
    const glob = normalized.search(/[*?[\]{}]/);
    if (glob >= 0) normalized = normalized.slice(0, glob);
    normalized = normalized.replace(/\/+$/, "");
    if (normalized.length > 0) required.add(normalized);
  };
  const walk = (value) => {
    if (typeof value === "string") add(value);
    else if (Array.isArray(value)) for (const item of value) walk(item);
    else if (value && typeof value === "object") for (const item of Object.values(value)) walk(item);
  };
  walk(pkg?.files);
  walk(pkg?.bin);
  walk(pkg?.exports);
  return [...required].sort();
}
