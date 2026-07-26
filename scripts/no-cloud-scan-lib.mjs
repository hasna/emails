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
  // ── operator neutrality ─────────────────────────────────────────────────────
  // A third party deploys this package into THEIR account with THEIR domains, so
  // the publisher's infrastructure must never ship — not in bundled code, and not
  // in the emitted `.d.ts` JSDoc, which `tsc --emitDeclarationOnly` preserves even
  // though Bun strips comments from the `.js` bundles.
  //
  // These are enforced on the source surface too, which reaches Terraform, shell
  // and container config: `deploy/**` is where an account id or an operator
  // hostname is most likely to leak, and it is scanned because the source guard
  // derives its file set from `git ls-files` rather than a roots allowlist.
  //
  // `\b[0-9]{12}\b` would be wrong for the account id: `-` is a word boundary, so
  // that form false-positives on every UUID. `stripExactCompatibilityBridges`
  // erases UUID-shaped tokens and long hex digests first, which lets this rule use
  // plain digit bounds and therefore still catch the form account ids actually take
  // in AWS resource names (`emails-<account>-us-east-1-inbound`,
  // `role/<name>-<account>-task`, `/ecs/emails-<account>/api`) — all of which a
  // hyphen-excluding lookaround would miss. The documented AWS placeholders
  // (111122223333, 123456789012) and the 999999999999 negative fixture are excluded
  // BY VALUE, never by exempting a file.
  {
    label: "vendor aws account id",
    scopes: BOTH,
    pattern: /(?<![0-9])(?!111122223333|123456789012|999999999999)[0-9]{12}(?![0-9])/,
  },
  // Any bare vendor hostname, including the `hasna.*` glob. The `hosted endpoint`
  // pattern above only catches URL form, which is why a vendor From-identity
  // default and a vendor signup-allowlist default both shipped.
  //
  // The lookahead exempts the four `hasna.<name>` identifiers that are NAMESPACES
  // rather than hostnames: the service-contract names (`hasna.contract.json`,
  // `hasna.service_contract.v1`), the macOS bundle id `com.hasna.emails`, and the
  // `hasna.events` event-source id that `@hasna/events` bundles into
  // dist/cli/ui-runtime-bundle.js. Each was found by running this guard, not
  // guessed. A NEW namespace of that shape will trip this rule, which is the safe
  // direction to fail.
  //
  // The `(?![a-z0-9-])` after the alternation is load-bearing. Without it the
  // exemption is PREFIX-matched, so any hostname whose first label merely STARTS
  // WITH one of the four words escapes the guard entirely: `hasna.emailservice.com`,
  // `hasna.eventsource.io` and `hasna.servicedesk.net` all passed.
  //
  // The class is `[a-z0-9-]`, not `[a-z]`: digits and hyphens are legal DNS label
  // characters, so a letters-only guard still let `hasna.emails2.com`,
  // `hasna.service-desk.net` and `hasna.events-api.io` through. The exemption
  // therefore covers a namespace only when the word ENDS there — the next character
  // must be something no DNS label can continue with (`.`, `_`, a quote, or
  // end-of-input). It does NOT cover anything that continues the word.
  //
  // Do NOT "simplify" this to a `\b` boundary. `_` is a word character, so
  // `(?:service)\b` does not match in `hasna.service_contract.v1` — the exemption
  // would stop applying and the guard would false-positive on a legitimate
  // service-contract name. A negative character class is correct where `\b` is not.
  {
    label: "vendor hostname",
    scopes: BOTH,
    pattern: /hasna\.(?!(?:contract|service|emails|events)(?![a-z0-9-]))(?:[a-z]{2,24}|\*)/i,
  },
  // Vendor account/environment names that identify private infrastructure.
  { label: "vendor infrastructure name", scopes: BOTH, pattern: /\balumia\b|\bxyz-infra\b/i },
  {
    label: "legacy hosted environment",
    scopes: BOTH,
    pattern: new RegExp(legacyHostedEnvKeys.join("|"), "i"),
    // `src/lib/mode.ts` (the rejection list) and `.github/workflows/ci.yml` (`env -u`)
    // are handled by stripExactCompatibilityBridges and need no allowance. What
    // remains is suites that assert the rejection, which must spell the variables
    // out. An EXACT path list was tried first and is wrong: `main` adds such suites
    // continuously, so it went stale within a day and turned CI red for changes the
    // guard had no opinion about. Scoped by shape instead — PRODUCT code naming a
    // retired variable still fails, which is the property that matters.
    sourceAllowance: {
      reason:
        "Test suites assert that the retired variables are REJECTED, so each has to name them as an input. " +
        "Non-test source is still checked, as is every packed bundle chunk.",
      paths: [/\.test\.ts$/],
    },
  },
  {
    label: "hosted implementation vocabulary",
    scopes: BOTH,
    pattern: /\b(?:saas|fleet)\b|cloud_/i,
    // `src/lib/mode.ts`, `src/server/self-hosted/migrations.ts` and
    // `src/server/self-hosted/service-resources.test.ts` are handled by
    // stripExactCompatibilityBridges and need no allowance.
    sourceAllowance: {
      reason:
        "Prose describing the pivot AWAY from a hosted SaaS/fleet (the changelog, design docs, the deploy " +
        "README, and the Terraform comment asserting no vendor-owned account), plus the suites that assert " +
        "`MAILERY_CLOUD_*` inputs are rejected. Non-test, non-prose source is still checked, as is every " +
        "packed bundle chunk — and the packed README is checked, because allowances are source-only.",
      paths: [/\.test\.ts$/, /^CHANGELOG\.md$/, /^docs\//, /^deploy\/aws\/README\.md$/, /^deploy\/aws\/backend\.tf$/],
    },
  },
];

function assertBoundaryPatternTable(table) {
  if (!Array.isArray(table) || table.length === 0) throw new Error("the boundary pattern table is empty");
  const seen = new Set();
  for (const entry of table) {
    const { label, pattern, scopes, exemptions = {}, sourceAllowance } = entry ?? {};
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
    if (sourceAllowance !== undefined) {
      const { reason, paths } = sourceAllowance;
      if (!(typeof reason === "string" && reason.trim().length > 0)) {
        throw new Error(`boundary pattern ${label} declares a sourceAllowance and records no reason`);
      }
      if (!Array.isArray(paths) || paths.length === 0) throw new Error(`boundary pattern ${label} declares an empty sourceAllowance.paths`);
      for (const matcher of paths) {
        if (!(matcher instanceof RegExp)) throw new Error(`boundary pattern ${label} has a non-RegExp sourceAllowance path`);
        // A matcher that accepts everything is a whole-scope exemption wearing a
        // path-shaped disguise; the point of an allowance is that it is narrow.
        for (const productPath of ["src/index.ts", "src/server/index.ts", "package.json"]) {
          if (matcher.test(productPath)) {
            throw new Error(`boundary pattern ${label} allows product code (${productPath}) via ${matcher}`);
          }
        }
      }
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

  // UUID-shaped tokens (permissive char class: fixtures use ids like
  // "rm000000-1111-2222-3333-444444444444") and long hex digests are erased so the
  // `vendor aws account id` rule can use plain digit bounds. This is a SHAPE
  // exemption, not a file exemption — a real account id in any of these positions
  // still trips.
  scanned = scanned.replace(/\b[0-9A-Za-z]{8}-[0-9A-Za-z]{4}-[0-9A-Za-z]{4}-[0-9A-Za-z]{4}-[0-9A-Za-z]{12}\b/g, "UUID_SENTINEL");
  scanned = scanned.replace(/\b[0-9a-fA-F]{16,}\b/g, "HEX_SENTINEL");

  // The npm `author` field is package AUTHORSHIP metadata, not deployment
  // configuration: a maintainer's contact address legitimately names their own
  // domain. Exempt exactly that ONE field value so `vendor hostname` keeps its
  // teeth everywhere else. `(?<![\w-])` keeps `coauthor`/`co-author` in scope.
  // Both spellings are needed: package.json itself, and the copy Bun inlines into
  // bundles that import it for `version`.
  scanned = scanned.replace(/(?<![\w-])("?)author\1\s*:\s*"[^"]*"/g, 'author: "AUTHORSHIP_SENTINEL"');

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
    .filter((entry) => !(scope === SOURCE_SCOPE && isSourceAllowed(entry, path)))
    .filter(({ pattern }) => pattern.test(scanned))
    .map(({ label }) => label);
}

/** True when `path` is inside this pattern's declared source allowance. */
export function isSourceAllowed(entry, path) {
  return (entry.sourceAllowance?.paths ?? []).some((matcher) => matcher.test(path));
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
