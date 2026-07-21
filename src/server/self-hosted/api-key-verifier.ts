import {
  extractToken,
  parseApiKey,
  verifyApiKey,
  type ApiKeyVerifier,
  type AuthAuditEvent,
  type AuthAuditHook,
  type VerifyApiKeyOptions,
} from "@hasna/contracts/auth";

/**
 * Build an API-key verifier that authenticates the canonical app slug PLUS any
 * back-compat aliases.
 *
 * During the "emails" -> "mailery" app-slug rename, keys already minted under
 * the old slug must keep verifying, so the self-hosted server accepts both. The
 * first entry in `apps` is canonical and is reported as `verifier.app`.
 *
 * Verification is attempted per app in order: an `app_mismatch` (the token was
 * minted for a different slug) falls through to the next alias; ANY other
 * failure (missing token, bad signature, expired, revoked, insufficient scope)
 * is terminal and returned as-is. The audit hook fires EXACTLY ONCE per request
 * (per-app verifiers are audit-free) so an accepted alias key does not also emit
 * a spurious `app_mismatch` deny line.
 */
export function verifyApiKeyWithAliases(
  options: Omit<VerifyApiKeyOptions, "app" | "audit"> & { audit?: AuthAuditHook },
  apps: readonly [string, ...string[]],
): ApiKeyVerifier {
  const { audit, ...base } = options;
  const canonicalApp = apps[0];
  const verifiers = apps.map((app) => verifyApiKey({ ...base, app }));

  return {
    app: canonicalApp,
    async authenticate(headers, context) {
      let decision = await verifiers[0]!.authenticate(headers, context);
      for (
        let i = 1;
        i < verifiers.length && !decision.ok && decision.reason === "app_mismatch";
        i++
      ) {
        decision = await verifiers[i]!.authenticate(headers, context);
      }

      if (audit) {
        // On a deny the AuthDecision carries no kid, so recover it structurally
        // from the presented token (no signature trust needed) to keep audit
        // lines forensically useful for revoked/expired keys. Null when the token
        // is absent or malformed.
        const denyKid = () => parseApiKey(extractToken(headers, base.headerName, base.scheme) ?? "")?.claims.kid ?? null;
        const event: AuthAuditEvent = {
          outcome: decision.ok ? "allow" : "deny",
          app: decision.ok ? decision.principal.app : canonicalApp,
          kid: decision.ok ? decision.principal.kid : denyKid(),
          reason: decision.ok ? null : decision.reason,
          scopesRequired: [...(context?.requiredScopes ?? [])],
          method: context?.method ?? null,
          path: context?.path ?? null,
          status: decision.status,
          at: new Date().toISOString(),
        };
        await audit(event);
      }

      return decision;
    },
  };
}
