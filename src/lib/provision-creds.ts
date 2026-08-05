/**
 * Provisioning credential status (emails) — reports whether usable
 * credentials are present for each provisioning provider, across all supported
 * auth modes. Pure (env injected); surfaced by
 * `emails doctor`.
 */

import { resolveCloudflareAuth, describeCloudflareAuth } from "./cloudflare-auth.js";

export interface ProvisionCredStatus {
  provider: string;
  /**
   * Whether usable credentials are present. `"unknown"` when an input this answer depends
   * on was itself unknown — see `aws_provider_credentials` below. A boolean here is a
   * CLAIM, and `false` is as much of a claim as `true`.
   */
  configured: boolean | "unknown";
  status?: "pass" | "warn" | "fail" | "unknown";
  detail: string;
}

export interface ProvisionCredConfig {
  /**
   * Whether this installation holds SES sending credentials on a stored provider row.
   *
   * `"unknown"` is a real, expected value and not a placeholder. The fact lives in the
   * provider columns that the store seam REDACTS from the generic resource read
   * (`REDACTED_COLUMNS` in src/store-sqlite/resources.ts; the API's resource routes are
   * summary-only for the same reason), so a caller reading providers through the seam —
   * which src/lib/doctor.ts now does — cannot observe it in either configuration.
   *
   * The type was widened rather than leaving the caller to pass one of the two booleans it
   * had: `false` here prints "Set AWS_PROFILE or AWS_ACCESS_KEY_ID/SECRET" with status
   * `fail` at an operator whose stored SES keys are perfectly fine, which is a fabricated
   * negative in a credential check.
   */
  aws_provider_credentials?: boolean | "unknown";
  cloudflare_api_token?: string;
  cloudflare_api_key?: string;
  cloudflare_email?: string;
  cloudflare_account_id?: string;
  /**
   * Whether provisioning for this installation is executed by the service behind its
   * configured API rather than by this process. When true, an ABSENT local Cloudflare or
   * Resend credential is `"unknown"`, not `fail`: the service holds its own provisioning
   * credentials, which are not observable from this client, so "Set CLOUDFLARE_API_TOKEN"
   * with status `fail` at an operator whose service-side credentials are fine is the same
   * fabricated negative `aws_provider_credentials` was widened to avoid (task 1c675265).
   * A credential that IS present locally still reports normally — presence is observable.
   */
  service_owned_provisioning?: boolean;
}

export function checkProvisionCredentials(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  config: ProvisionCredConfig = {},
): ProvisionCredStatus[] {
  const out: ProvisionCredStatus[] = [];

  // AWS (SES send/inbound + domain purchase via @hasna/domains), us-east-1.
  const hasEnvAws = !!(env["AWS_ACCESS_KEY_ID"] && env["AWS_SECRET_ACCESS_KEY"]) || !!env["AWS_PROFILE"];
  const storedSesProviderCredentials = config.aws_provider_credentials ?? false;
  // Environment credentials are observable either way, so they still decide the answer on
  // their own. The unknown only propagates when they are ABSENT — the one case where the
  // verdict actually depended on the stored-credential fact.
  const storedUnknown = !hasEnvAws && storedSesProviderCredentials === "unknown";
  const hasStoredSesProviderCredentials = storedSesProviderCredentials === true;
  out.push({
    provider: "aws",
    configured: storedUnknown ? "unknown" : hasEnvAws || hasStoredSesProviderCredentials,
    status: hasEnvAws ? "pass" : storedUnknown ? "unknown" : hasStoredSesProviderCredentials ? "warn" : "fail",
    detail: hasEnvAws
      ? `${env["AWS_PROFILE"] ? `profile:${env["AWS_PROFILE"]}` : "access-keys"} (us-east-1 for SES inbound + AWS domain purchase)`
      : storedUnknown
        ? "No AWS credentials in the environment, and whether SES credentials are stored on a provider row is not observable to the caller (the store seam redacts credential columns). Set AWS_PROFILE or AWS_ACCESS_KEY_ID/SECRET for AWS domain purchase/provisioning workflows, and run 'emails provider status' to validate stored SES credentials."
      : hasStoredSesProviderCredentials
        ? "Stored SES provider credentials found for SES send/inbound; set AWS_PROFILE or AWS_ACCESS_KEY_ID/SECRET for AWS domain purchase/provisioning workflows"
      : "Set AWS_PROFILE or AWS_ACCESS_KEY_ID/SECRET",
  });

  // Cloudflare (DNS + Email Routing).
  const cf = resolveCloudflareAuth({
    env,
    configToken: config.cloudflare_api_token,
    configApiKey: config.cloudflare_api_key,
    configEmail: config.cloudflare_email,
  });
  const cfAccountId = env["CLOUDFLARE_ACCOUNT_ID"] ?? config.cloudflare_account_id;
  const cfAbsentUnknown = !cf && config.service_owned_provisioning === true;
  out.push({
    provider: "cloudflare",
    configured: cfAbsentUnknown ? "unknown" : !!cf,
    status: cf ? cfAccountId ? "pass" : "warn" : cfAbsentUnknown ? "unknown" : "fail",
    detail: cf
      ? describeCloudflareAuth(cf) + (cfAccountId ? " (+account)" : " (no account id — zone create needs it)")
      : cfAbsentUnknown
        ? "No Cloudflare credentials on this client, and provisioning for an API-backed installation is executed by the service, whose credentials are not observable from here. Set CLOUDFLARE_API_TOKEN or CLOUDFLARE_API_KEY+CLOUDFLARE_EMAIL only for local provisioning workflows."
        : "Set CLOUDFLARE_API_TOKEN or CLOUDFLARE_API_KEY+CLOUDFLARE_EMAIL",
  });

  // Resend (optional secondary send + inbound webhook).
  const resend = !!env["RESEND_API_KEY"];
  const resendAbsentUnknown = !resend && config.service_owned_provisioning === true;
  out.push({
    provider: "resend",
    configured: resendAbsentUnknown ? "unknown" : resend,
    ...(resendAbsentUnknown ? { status: "unknown" as const } : {}),
    detail: resend
      ? "key present"
      : resendAbsentUnknown
        ? "optional — Resend send/inbound for an API-backed installation is configured on the service; set RESEND_API_KEY only for local workflows"
        : "optional — set RESEND_API_KEY for Resend send/inbound",
  });

  return out;
}
