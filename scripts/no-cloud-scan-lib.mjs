const legacyHostedEnvKeys = [
  "MAILERY_API_URL",
  "MAILERY_API_KEY",
  "MAILERY_CLOUD_API_URL",
  "MAILERY_CLOUD_TOKEN",
  "HASNA_MAILERY_API_URL",
  "HASNA_MAILERY_API_KEY",
];

// This is a PRIVATE, internal MULTI-TENANT app. Legitimate tenancy vocabulary
// (tenants/users/auth/memberships/sessions, `tenant_id`, /v1/auth/*, /v1/tenants)
// is ALLOWED — the deliberate P1/P2/P3 pivot added it on purpose. What must never
// ship is a HOSTED cloud control plane: hardcoded account ids / hosted endpoint
// URLs, bundled cloud-AI provider clients, and billing/credit/stripe surfaces.
const patterns = [
  ["hosted package", /@hasna\/cloud\b/i],
  ["hosted endpoint", /https?:\/\/(?:[^/]*\.)?(?:mailery\.co|emails\.hasna\.xyz)/i],
  // Control-plane billing/credit routes only. Auth/login|signup and /v1/tenants
  // are legitimate self-hosted multi-tenant routes and are intentionally allowed.
  ["hosted billing route", /\/(?:api\/)?v1\/(?:billing|checkout|portal|credits?)\b/i],
  // Cloud-account data fields only. `tenant_id` is a legitimate per-row isolation
  // column here and is intentionally NOT flagged.
  ["hosted data field", /\b(?:cloud_api_url|cloud_session_token|cloud_api_key|stripe_customer_id|credit_balance)\b/i],
  ["cloud ai provider client", /@ai-sdk\/(?:cerebras|groq)\b|\b(?:GROQ|CEREBRAS)_API_KEY\b|api\.cerebras\.ai|api\.groq\.com/i],
  ["private deployment marker", /\bhasna-xyz\b|\/hasna\/deploy\/|789877399345/i],
  ["retired inbound bucket prefix", /hasna-emails-prod-inbound/i],
  ["legacy hosted environment", new RegExp(legacyHostedEnvKeys.join("|"), "i")],
  ["hosted implementation vocabulary", /\b(?:saas|fleet)\b|cloud_/i],
  ["hosted camel-case identifier", /(?:cloud|Cloud)(?:Provider|Client|Account|Tenant|Session|Api|API|Token|Credit|Billing|Fleet|Mode|Sync)[A-Za-z0-9_]*/],
];

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

export function hostedControlPlaneFindings(content, path = "artifact") {
  const scanned = stripExactCompatibilityBridges(content, path);
  return patterns
    .filter(([, pattern]) => pattern.test(scanned))
    .map(([label]) => label);
}
