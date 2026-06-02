/**
 * Per-address inbound wiring — add/remove a single recipient on an existing SES
 * receipt rule without recreating the rule set. SES receipt rules live on the
 * SES v1 API. The client is injected (minimal `send` surface) for testability.
 *
 * A rule's `Recipients` list matches inbound recipients; an empty/absent list
 * means "match all for the domain". These helpers manage explicit per-address
 * recipients (e.g. wiring andrew@domain into the domain's rule).
 */

export interface SesV1ClientLike {
  send: (cmd: unknown) => Promise<any>;
}

export interface RecipientRuleRef {
  ruleSetName: string;
  ruleName: string;
}

async function getRule(client: SesV1ClientLike, ref: RecipientRuleRef): Promise<any> {
  const { DescribeReceiptRuleCommand } = await import("@aws-sdk/client-ses");
  const res = await client.send(new DescribeReceiptRuleCommand({ RuleSetName: ref.ruleSetName, RuleName: ref.ruleName }));
  if (!res.Rule) throw new Error(`Receipt rule not found: ${ref.ruleSetName}/${ref.ruleName}`);
  return res.Rule;
}

async function putRule(client: SesV1ClientLike, ref: RecipientRuleRef, rule: any): Promise<void> {
  const { UpdateReceiptRuleCommand } = await import("@aws-sdk/client-ses");
  await client.send(new UpdateReceiptRuleCommand({ RuleSetName: ref.ruleSetName, Rule: rule }));
}

/** Compute the new recipients set after adding (pure, exported for testing). */
export function withRecipient(recipients: string[], address: string): string[] {
  const set = new Set((recipients ?? []).map((r) => r.toLowerCase()));
  set.add(address.toLowerCase());
  return [...set];
}

/** Compute the new recipients set after removing (pure). */
export function withoutRecipient(recipients: string[], address: string): string[] {
  return (recipients ?? []).filter((r) => r.toLowerCase() !== address.toLowerCase());
}

export async function addRecipient(client: SesV1ClientLike, ref: RecipientRuleRef, address: string): Promise<{ changed: boolean; recipients: string[] }> {
  const rule = await getRule(client, ref);
  const current: string[] = rule.Recipients ?? [];
  const next = withRecipient(current, address);
  if (next.length === current.length && current.map((r) => r.toLowerCase()).includes(address.toLowerCase())) {
    return { changed: false, recipients: current };
  }
  await putRule(client, ref, { ...rule, Recipients: next });
  return { changed: true, recipients: next };
}

export async function removeRecipient(client: SesV1ClientLike, ref: RecipientRuleRef, address: string): Promise<{ changed: boolean; recipients: string[] }> {
  const rule = await getRule(client, ref);
  const current: string[] = rule.Recipients ?? [];
  const next = withoutRecipient(current, address);
  if (next.length === current.length) return { changed: false, recipients: current };
  await putRule(client, ref, { ...rule, Recipients: next });
  return { changed: true, recipients: next };
}
