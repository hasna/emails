/**
 * Where provider credentials may live, and what to say when they may not.
 *
 * Local mode keeps per-provider credentials in its own SQLite row and uses them
 * to send. The self-hosted `/v1/providers` resource has NO credential columns —
 * the server signs with credentials from its own environment. Passing
 * `--api-key`/`--access-key`/`--secret-key` at a self-hosted client therefore
 * used to be accepted, silently dropped on the wire, and then reported back as
 * "Provider credentials are invalid". Both halves of that were false, and the
 * send path kept using the deployment IAM role. One shared guard so no caller
 * can reintroduce the silent drop.
 */
import type { CreateProviderInput } from "../types/index.js";

export const PROVIDER_CREDENTIAL_FIELDS = ["api_key", "access_key", "secret_key"] as const;

export class SelfHostedProviderCredentialsUnsupportedError extends Error {
  constructor(readonly fields: readonly string[]) {
    super(
      `The self-hosted emails server does not store per-provider credentials (${fields.join(", ")}). ` +
        "It signs outbound mail with the credentials in the SERVER environment: " +
        "EMAILS_SES_ACCESS_KEY_ID + EMAILS_SES_SECRET_ACCESS_KEY (SES, injected from your secret store) " +
        "or RESEND_API_KEY (Resend), selected by EMAILS_SEND_PROVIDER. " +
        "Re-run without the credential flags to register provider metadata, " +
        "or set the credentials on the server and redeploy.",
    );
    this.name = "SelfHostedProviderCredentialsUnsupportedError";
  }
}

/** Which credential fields the caller actually supplied a non-empty value for. */
export function suppliedProviderCredentialFields(input: Partial<CreateProviderInput>): string[] {
  return PROVIDER_CREDENTIAL_FIELDS.filter((field) => {
    const value = input[field];
    return typeof value === "string" && value.trim().length > 0;
  });
}

/** Throw when credentials were supplied to a backend that cannot store them. */
export function assertNoProviderCredentials(input: Partial<CreateProviderInput>): void {
  const supplied = suppliedProviderCredentialFields(input);
  if (supplied.length > 0) throw new SelfHostedProviderCredentialsUnsupportedError(supplied);
}
