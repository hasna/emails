import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The AWS module historically assumed SES lives in the same account as the ECS
// tasks, so the API container had no way to present credentials at all
// (src/server/self-hosted/sender.ts pins access_key/secret_key to null and
// src/providers/ses.ts then falls back to the SDK default chain, i.e. the task
// role). Any deployment whose production-access SES sits in a *different*
// account than the ECS cluster therefore cannot send, and every external
// recipient is rejected by the sandbox account with MessageRejected.
//
// The module now accepts operator-owned Secrets Manager ARNs for the SES access
// key id and secret access key and injects them into the API container through
// the `secrets` block. These tests pin the parts that are dangerous to get
// wrong: never plaintext, never on the worker, and always accompanied by the
// matching execution-role grant.

const read = (relativePath: string) =>
  readFileSync(resolve(import.meta.dir, "..", relativePath), "utf8");

const compute = read("deploy/aws/compute.tf");
const variables = read("deploy/aws/variables.tf");
const iam = read("deploy/aws/iam.tf");

/** Body of a `locals { ... }`-style assignment such as `api_environment = [...]`. */
function assignment(source: string, name: string): string {
  const start = source.indexOf(`${name} = `);
  if (start === -1) throw new Error(`missing assignment: ${name}`);
  // The statement runs until the first newline reached at bracket depth zero.
  // Stopping at the first balanced pair instead would truncate
  // `x = cond ? [] : [ ... ]` at the empty list.
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (char === "[" || char === "{" || char === "(") depth += 1;
    else if (char === "]" || char === "}" || char === ")") depth -= 1;
    else if (char === "\n" && depth === 0) return source.slice(start, i);
  }
  throw new Error(`unterminated assignment: ${name}`);
}

/** The `container_definitions = jsonencode([{ ... }])` body of one task definition. */
function containerDefinitions(taskDefinitionName: string): string {
  const start = compute.indexOf(`resource "aws_ecs_task_definition" "${taskDefinitionName}"`);
  if (start === -1) throw new Error(`missing task definition: ${taskDefinitionName}`);
  const next = compute.indexOf('\nresource "', start + 1);
  return compute.slice(start, next === -1 ? compute.length : next);
}

const SES_CREDENTIAL_ENV_NAMES = [
  // Repoints the SDK default credential chain. Required by the shipped image,
  // whose SES adapter reads AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY.
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  // Scoped names, read directly by the sender when present.
  "EMAILS_SES_ACCESS_KEY_ID",
  "EMAILS_SES_SECRET_ACCESS_KEY",
] as const;

describe("AWS module SES credential injection", () => {
  test("exposes optional, both-or-neither SES credential secret ARN variables", () => {
    for (const name of ["ses_access_key_id_secret_arn", "ses_secret_access_key_secret_arn"]) {
      const start = variables.indexOf(`variable "${name}"`);
      expect(start).toBeGreaterThan(-1);
      const block = variables.slice(start, variables.indexOf("\n}", start));
      expect(block).toContain("type        = string");
      expect(block).toContain("default     = null");
      expect(block).toContain("nullable    = true");
    }

    // Half a credential pair is worse than none: it silently keeps using the
    // task role while looking configured. Fail the plan instead.
    expect(compute).toContain(
      "(var.ses_access_key_id_secret_arn == null) == (var.ses_secret_access_key_secret_arn == null)",
    );
  });

  test("injects both the default-chain and the scoped credential names by ARN", () => {
    const block = assignment(compute, "ses_credential_secrets");
    for (const name of SES_CREDENTIAL_ENV_NAMES) {
      expect(block).toContain(`name      = "${name}"`);
    }
    expect(block).toContain("valueFrom = var.ses_access_key_id_secret_arn");
    expect(block).toContain("valueFrom = var.ses_secret_access_key_secret_arn");
    // Absent configuration must leave the task definition byte-identical.
    expect(block).toContain("var.ses_access_key_id_secret_arn == null ? [] :");
  });

  test("never puts a SES credential in a plaintext environment block", () => {
    for (const name of ["api_environment", "worker_environment", "common_environment"]) {
      const block = assignment(compute, name);
      for (const credential of SES_CREDENTIAL_ENV_NAMES) {
        expect(block).not.toContain(credential);
      }
    }
    // The variables carry ARNs, never values.
    expect(variables).not.toMatch(/variable "ses_(?:access_key_id|secret_access_key)"/);
  });

  test("wires the credentials into the API task only, never the worker or migration", () => {
    const api = containerDefinitions("api");
    expect(api).toContain("local.ses_credential_secrets");
    expect(api).toContain("secrets                = concat(");

    for (const other of ["worker", "migration"] as const) {
      // The alumia-style SES principal is scoped to ses:*/sesv2:*; handing it to
      // the ingest worker would strip its SQS and inbound-bucket access and
      // silently break inbound mail.
      expect(containerDefinitions(other)).not.toContain("ses_credential_secrets");
    }
  });

  test("grants the API execution role read access on the SES secrets, stripped of the JSON-key suffix", () => {
    const block = assignment(iam, "execution_secret_arns");
    expect(block).toContain("local.ses_secret_iam_arns");
    // `arn:...:secret:name-suffix:JSON_KEY::` is a valid `valueFrom` but NOT a
    // valid IAM resource ARN. Only the first seven colon-separated segments are.
    const stripped = assignment(iam, "ses_secret_iam_arns");
    expect(stripped).toContain('join(":", slice(split(":", arn), 0, 7))');

    for (const role of ["worker", "migration"]) {
      expect(block).not.toMatch(new RegExp(`${role}\\s*=[^\\n]*ses_secret_iam_arns`));
    }
  });

  test("lets the execution role decrypt an operator-supplied CMK when one is used", () => {
    const start = variables.indexOf('variable "ses_credentials_kms_key_arn"');
    expect(start).toBeGreaterThan(-1);
    expect(iam).toContain("local.ses_credentials_kms_key_arns");
  });
});
