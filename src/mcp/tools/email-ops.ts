// The email-operation MCP tools. ONE implementation, one tool set.
//
// WHAT THIS FILE USED TO BE. Three modules: this facade, which read the
// process-wide deployment-word helper (`src/lib/mode.ts`) and picked one of two
// sibling arm modules, and the two arms themselves — 554 and 539 lines that
// registered the SAME seventeen tool names with byte-identical input schemas.
// Sixteen of those seventeen differed only in WHICH MODULE LAYER a handler
// imported: one arm reached into the `*.local.*` arm of another family directly,
// the other called that family's facade. That is a difference about who runs the
// code, not about what the operation means, and it is what this collapse deletes.
//
// THE RULE THIS FILE NOW FOLLOWS: every handler calls the owning family's FACADE
// and never an arm module. A facade already resolves correctly under either
// storage configuration, so one call site is behaviour-identical to BOTH of the
// arms it replaces. Whatever selection remains lives inside those families and
// is deleted when each of them collapses — it is no longer duplicated here.
//
// THE TOOL SET IS UNCONDITIONAL. All seventeen tools register in every
// configuration. "Why is this tool missing?" must never have an answer that
// depends on the environment; a tool this installation cannot serve says so when
// it is called, in a form the caller can act on.
//
// REFUSALS MUST NOT ADVERTISE THEIR OWN CIRCUMVENTION. The module this replaced
// emitted a refusal that told the caller which environment variable to set to get
// the other arm's behaviour — i.e. it documented its own bypass to an untrusted
// caller. Nothing here names a setting that would change the answer. A refusal
// carries a code, a status, the reason, and where applicable a runnable command;
// it never carries a switch.
//
// AND A REFUSAL IS NEVER AN EMPTY RESULT. No handler below answers a question it
// cannot answer with `[]`, `0`, `null`, or a cheerful "nothing to do". An empty
// list is indistinguishable from a true empty result, which makes the bug
// invisible at the call site; a refusal is not.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const MAX_MCP_EMAIL_LIST_LIMIT = 1000;

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

async function toolError(error: unknown): Promise<ToolResult> {
  const { formatError } = await import("../helpers.js");
  return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
}

/**
 * A refusal the caller can act on.
 *
 * `code` and `status` are the machine-readable part and are spelled in the
 * refusal vocabulary of the store seam (src/store/outcome.ts) so a caller that
 * already understands one understands the other. They are carried in the text
 * because that is the only channel an MCP tool error has: the contract wrapper
 * (src/mcp/contracts.ts, `normalizeResult`) re-reads an errored result's text as
 * the error message, so a JSON envelope built here would end up stringified
 * inside a field rather than parsed.
 *
 * `remedy` is optional and must be a COMMAND, never a setting. A refusal that
 * names an environment variable teaches the caller how to defeat it.
 */
function refusal(code: string, status: number, reason: string, remedy?: string): ToolResult {
  const text = `Refused (code=${code}, status=${status}): ${reason}${remedy ? ` Run: ${remedy}` : ""}`;
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Options `send_email` accepts in its schema but this build's single send path
 * cannot carry, mapped to what the caller loses by passing them.
 *
 * WHY THEY ARE REFUSED RATHER THAN DROPPED. The one send entrypoint
 * (`resolveMailDataSource().send`, the same one `emails send` uses) takes the
 * shape declared at src/lib/mail-data-source.ts:125-152, which carries none of
 * these four. Passing them through would therefore mean IGNORING them, and for
 * `auth_token` that is not cosmetic: it is the scoped send-key check at
 * src/lib/send.local.ts:119-122, which decides whether the caller is allowed to
 * send from that address at all. A silently-ignored authorization check is worse
 * than a refused send, so this fails closed.
 *
 * WHY THEY ARE NOT REMOVED FROM THE SCHEMA. An MCP input schema that does not
 * declare a key drops it silently, which is the exact failure being avoided.
 * They stay declared, and passing one is answered.
 *
 * This is the one place the two arms genuinely disagreed about what the operation
 * can DO rather than about who runs it, and closing it needs the single send
 * service that phase 8 of docs/PLAN-MODE-REMOVAL.md is chartered to build. Until
 * then the honest answer is the same in every configuration.
 */
const UNCARRIED_SEND_OPTIONS: ReadonlyArray<{ key: string; loses: string }> = Object.freeze([
  { key: "auth_token", loses: "the scoped send-key authorization check would not run" },
  { key: "unsubscribe_url", loses: "the RFC 8058 List-Unsubscribe headers would not be injected" },
  { key: "headers", loses: "the custom headers would not reach the message" },
  { key: "tags", loses: "the tags would not be recorded" },
]);

/** Split an address option into trimmed, non-empty addresses. */
function addressList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : String(value).split(","))
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/** Join an address option into the comma-separated form the send path takes. */
function addressCsv(value: string | string[] | undefined): string | undefined {
  const list = addressList(value);
  return list.length === 0 ? undefined : list.join(", ");
}

export function registerEmailOpsTools(server: McpServer): void {
  // ─── SEND EMAIL ───────────────────────────────────────────────────────────────

  server.tool(
  "send_email",
  "Send an email via the configured provider",
  {
    from: z.string().describe("Sender email address"),
    to: z.union([z.string(), z.array(z.string())]).describe("Recipient(s)"),
    subject: z.string().optional().describe("Email subject (required if no template)"),
    html: z.string().optional().describe("HTML body"),
    text: z.string().optional().describe("Plain text body"),
    cc: z.union([z.string(), z.array(z.string())]).optional().describe("CC recipients"),
    bcc: z.union([z.string(), z.array(z.string())]).optional().describe("BCC recipients"),
    reply_to: z.string().optional().describe("Reply-to address"),
    provider_id: z.string().optional().describe("Provider ID (uses active provider if not specified)"),
    template: z.string().optional().describe("Template name to use"),
    template_vars: z.record(z.string()).optional().describe("Variables to render into the template"),
    attachments: z
      .array(
        z.object({
          filename: z.string(),
          content: z.string().describe("Base64 encoded content"),
          content_type: z.string(),
        }),
      )
      .optional()
      .describe("Email attachments"),
    tags: z.record(z.string()).optional().describe("Key-value tags"),
    headers: z.record(z.string()).optional().describe("Custom email headers"),
    unsubscribe_url: z.string().optional().describe("Auto-inject List-Unsubscribe headers (RFC 8058 one-click)"),
    idempotency_key: z.string().optional().describe("Prevent duplicate sends — returns existing email if key was used before"),
    auth_token: z.string().optional().describe("Scoped send key (esk_…) — restricts sending to addresses the key's owner owns or administers"),
  },
  async (input) => {
    try {
      // 1. Options this build's send path cannot carry are answered, not ignored.
      const uncarried = UNCARRIED_SEND_OPTIONS.filter(
        (option) => (input as Record<string, unknown>)[option.key] !== undefined,
      );
      if (uncarried.length > 0) {
        return refusal(
          "option_not_carried",
          422,
          `send_email cannot carry ${uncarried.map((option) => option.key).join(", ")}: ` +
            `${uncarried.map((option) => option.loses).join("; ")}. Sending anyway would ignore ` +
            "them without saying so, so this send is refused instead. Remove the option(s) to send.",
        );
      }

      // 2. Templates. Resolved through the templates FACADE, so a template lives
      //    wherever this installation keeps its templates.
      const { getTemplate, renderTemplate } = await import('../../db/templates.js');
      let subject = input.subject || "";
      let html = input.html;
      let text = input.text;
      if (input.template) {
        const tpl = getTemplate(input.template);
        if (!tpl) throw new Error(`Template not found: ${input.template}`);
        const vars = input.template_vars || {};
        subject = renderTemplate(tpl.subject_template, vars);
        if (tpl.html_template) html = renderTemplate(tpl.html_template, vars);
        if (tpl.text_template) text = renderTemplate(tpl.text_template, vars);
      }
      if (!subject) throw new Error("Subject is required (provide subject or template)");

      // 3. Suppression, enforced HERE and in every configuration.
      //
      //    This is the model-driven surface, and there is deliberately no `force`
      //    parameter: an agent must not be able to override a suppression. The
      //    check used to exist in only one of the two arms, which meant an
      //    installation that keeps its contacts on a server had no client-side
      //    gate at all and relied entirely on the service answering 409. Both
      //    obligations are kept: this gate runs first, and the service's refusal
      //    remains behind it.
      const { suppressedRecipientsAmong } = await import('../../db/contacts.js');
      const recipients = [...addressList(input.to), ...addressList(input.cc), ...addressList(input.bcc)];
      const suppressed = suppressedRecipientsAmong(recipients);
      if (suppressed.length > 0) {
        throw new Error(
          `Refusing to send to suppressed recipient(s): ${suppressed.join(", ")}. `
          + "Clear the suppression first (emails contact unsuppress <email>).",
        );
      }

      // 4. Dispatch. ONE send path — the same one `emails send` uses
      //    (src/cli/commands/send.ts). Attachment caps, warming limits, sender
      //    readiness and provider failover are enforced inside it
      //    (src/lib/send.local.ts:111-158) or by the service, so they are not
      //    re-implemented here where they could drift.
      //
      //    `markdown: false` is passed explicitly, matching `emails send`: the
      //    caller has separate `text` and `html` parameters, so silently
      //    markdown-rendering `text` into an HTML part it did not ask for is a
      //    body the caller never wrote.
      const { resolveMailDataSource } = await import('../../lib/mail-data-source.js');
      const result = await resolveMailDataSource().send({
        from: input.from,
        to: addressCsv(input.to) ?? "",
        cc: addressCsv(input.cc),
        bcc: addressCsv(input.bcc),
        replyTo: input.reply_to,
        subject,
        body: text ?? "",
        html,
        markdown: false,
        providerId: input.provider_id,
        attachments: input.attachments,
        idempotencyKey: input.idempotency_key,
      });

      // 5. An idempotent send that is ALREADY IN FLIGHT is not a success. The
      //    module this replaced reported `success: true` for it, which tells the
      //    caller the mail is away and invites a retry under a different key —
      //    the comfortable-success failure this surface must not have.
      if (result.inProgress) {
        return refusal(
          "conflict",
          409,
          `an identical send is already in progress for ${addressCsv(input.to) ?? "the recipient(s)"}; ` +
            "it has NOT been re-sent and must not be retried with a different idempotency key. " +
            "Check whether the first attempt completed before sending again.",
          // A remedy has to be RUNNABLE. `emails log` is the sent-email log this
          // repository actually registers (src/mcp/contracts.ts maps `list_emails`
          // to it); an invented `emails email list` would send the caller looking
          // for a command that does not exist, which is the same defect as naming
          // a service that was never deployed.
          "emails log --json",
        );
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                email_id: result.id,
                message_id: result.messageId,
                // Carried through rather than dropped: the message DID leave, and
                // a post-send step did not. The caller must not re-send.
                ...(result.warning ? { warning: result.warning } : {}),
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (e) {
      return toolError(e);
    }
  },
  );

  // ─── EMAILS ───────────────────────────────────────────────────────────────────

  server.tool(
  "list_emails",
  "List sent emails with optional filters",
  {
    provider_id: z.string().optional().describe("Filter by provider ID"),
    status: z
      .enum(["sent", "delivered", "bounced", "complained", "failed"])
      .optional()
      .describe("Filter by status"),
    from_address: z.string().optional().describe("Filter by sender address"),
    since: z.string().optional().describe("ISO timestamp - only show emails after this"),
    limit: z.number().int().positive().max(MAX_MCP_EMAIL_LIST_LIMIT).optional().describe("Max results (default 50, max 1000)"),
    offset: z.number().int().min(0).optional().describe("Pagination offset"),
  },
  async (input) => {
    try {
      const { listEmails } = await import('../../db/emails.js');
      const { resolveId } = await import('../helpers.js');
      const resolvedProviderId = input.provider_id
        ? resolveId("providers", input.provider_id)
        : undefined;
      const emails = listEmails({
        ...input,
        provider_id: resolvedProviderId,
        limit: input.limit ?? 50,
        offset: input.offset ?? 0,
      });
      return { content: [{ type: "text", text: JSON.stringify(emails, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
  );

  server.tool(
  "search_emails",
  "Search emails by subject, from address, or to address",
  {
    query: z.string().describe("Search query (matches subject, from, or to)"),
    since: z.string().optional().describe("ISO timestamp - only show emails after this"),
    limit: z.number().int().positive().max(MAX_MCP_EMAIL_LIST_LIMIT).optional().describe("Max results (default 50, max 1000)"),
    offset: z.number().int().min(0).optional().describe("Pagination offset"),
  },
  async ({ query, since, limit, offset }) => {
    try {
      const { searchEmails } = await import('../../db/emails.js');
      const emails = searchEmails(query, { since, limit: limit ?? 50, offset: offset ?? 0 });
      return { content: [{ type: "text", text: JSON.stringify(emails, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
  );

  server.tool(
  "get_email",
  "Get details of a specific email",
  {
    email_id: z.string().describe("Email ID (or prefix)"),
  },
  async ({ email_id }) => {
    try {
      const { getEmail } = await import('../../db/emails.js');
      const { resolveId, EmailNotFoundError } = await import('../helpers.js');
      const id = resolveId("emails", email_id);
      const email = getEmail(id);
      if (!email) throw new EmailNotFoundError(id);
      return { content: [{ type: "text", text: JSON.stringify(email, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
  );

  server.tool(
  "get_email_content",
  "Get the full content (body, headers) of a sent email",
  {
    email_id: z.string().describe("Email ID (or prefix)"),
  },
  async ({ email_id }) => {
    try {
      const { getEmail } = await import('../../db/emails.js');
      const { getEmailContent } = await import('../../db/email-content.js');
      const { resolveId, EmailNotFoundError } = await import('../helpers.js');
      const id = resolveId("emails", email_id);
      const email = getEmail(id);
      if (!email) throw new EmailNotFoundError(id);
      const content = getEmailContent(id);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ email, content: content || { html: null, text_body: null, headers: {} } }, null, 2),
        }],
      };
    } catch (e) {
      return toolError(e);
    }
  },
  );

  // ─── EVENTS ───────────────────────────────────────────────────────────────────

  server.tool(
  "pull_events",
  "Pull latest events from provider(s) and store locally",
  {
    provider_id: z.string().optional().describe("Provider ID (syncs all if not specified)"),
  },
  async ({ provider_id }) => {
    try {
      const { syncProvider, syncAll } = await import('../../lib/sync.js');
      const { resolveId } = await import('../helpers.js');
      let result: Record<string, number>;
      if (provider_id) {
        const id = resolveId("providers", provider_id);
        const count = await syncProvider(id);
        result = { [id]: count };
      } else {
        result = await syncAll();
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
  );

  // ─── STATS ────────────────────────────────────────────────────────────────────

  server.tool(
  "get_stats",
  "Get email delivery statistics",
  {
    provider_id: z.string().optional().describe("Provider ID (all providers if not specified)"),
    period: z.string().optional().describe("Period: 7d, 30d, 90d (default 30d)"),
  },
  async ({ provider_id, period }) => {
    try {
      const { getLocalStats } = await import('../../lib/stats.js');
      const { resolveId } = await import('../helpers.js');
      const resolvedId = provider_id ? resolveId("providers", provider_id) : undefined;
      const stats = await getLocalStats(resolvedId, period ?? "30d");
      return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
  );

  // ─── TEMPLATES ───────────────────────────────────────────────────────────────

  server.tool(
  "list_templates",
  "List all email templates",
  {
    limit: z.number().int().positive().max(1000).optional().describe("Maximum templates to return"),
    offset: z.number().int().min(0).optional().describe("Number of templates to skip"),
  },
  async ({ limit, offset }) => {
    try {
      const { listTemplateSummaries } = await import('../../db/templates.js');
      const templates = listTemplateSummaries({ limit: limit ?? 100, offset: offset ?? 0 });
      return { content: [{ type: "text", text: JSON.stringify(templates, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
  );

  server.tool(
  "get_template",
  "Get full email template details by name or ID",
  {
    name_or_id: z.string().describe("Template name or ID"),
  },
  async ({ name_or_id }) => {
    try {
      const { getTemplate } = await import('../../db/templates.js');
      const template = getTemplate(name_or_id);
      if (!template) throw new Error(`Template not found: ${name_or_id}`);
      return { content: [{ type: "text", text: JSON.stringify(template, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
  );

  server.tool(
  "add_template",
  "Create a new email template",
  {
    name: z.string().describe("Unique template name"),
    subject_template: z.string().describe("Subject template (supports {{var}} placeholders)"),
    html_template: z.string().optional().describe("HTML body template"),
    text_template: z.string().optional().describe("Plain text body template"),
  },
  async (input) => {
    try {
      const { createTemplate } = await import('../../db/templates.js');
      const template = createTemplate(input);
      return { content: [{ type: "text", text: JSON.stringify(template, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
  );

  server.tool(
  "remove_template",
  "Delete a template by name or ID",
  {
    name_or_id: z.string().describe("Template name or ID"),
  },
  async ({ name_or_id }) => {
    try {
      const { deleteTemplate } = await import('../../db/templates.js');
      const deleted = deleteTemplate(name_or_id);
      if (!deleted) throw new Error(`Template not found: ${name_or_id}`);
      return { content: [{ type: "text", text: `Template removed: ${name_or_id}` }] };
    } catch (e) {
      return toolError(e);
    }
  },
  );

  // ─── CONTACTS ────────────────────────────────────────────────────────────────

  server.tool(
  "list_contacts",
  "List tracked email contacts",
  {
    suppressed: z.boolean().optional().describe("Filter by suppression status"),
    limit: z.number().int().positive().max(1000).optional().describe("Maximum contacts to return"),
    offset: z.number().int().min(0).optional().describe("Number of contacts to skip"),
  },
  async ({ suppressed, limit, offset }) => {
    try {
      const { listContacts } = await import('../../db/contacts.js');
      const contacts = listContacts({
        ...(suppressed !== undefined ? { suppressed } : {}),
        limit: limit ?? 100,
        offset: offset ?? 0,
      });
      return { content: [{ type: "text", text: JSON.stringify(contacts, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
  );

  server.tool(
  "suppress_contact",
  "Suppress a contact email (prevent sending)",
  {
    email: z.string().describe("Email address to suppress"),
  },
  async ({ email }) => {
    try {
      const { suppressContact } = await import('../../db/contacts.js');
      suppressContact(email);
      return { content: [{ type: "text", text: `Contact suppressed: ${email}` }] };
    } catch (e) {
      return toolError(e);
    }
  },
  );

  server.tool(
  "unsuppress_contact",
  "Unsuppress a contact email (allow sending again)",
  {
    email: z.string().describe("Email address to unsuppress"),
  },
  async ({ email }) => {
    try {
      const { unsuppressContact } = await import('../../db/contacts.js');
      unsuppressContact(email);
      return { content: [{ type: "text", text: `Contact unsuppressed: ${email}` }] };
    } catch (e) {
      return toolError(e);
    }
  },
  );


  // ─── SCHEDULED ──────────────────────────────────────────────────────────────

  server.tool(
  "schedule_email",
  "Schedule an email to be sent later",
  {
    from: z.string().describe("Sender email address"),
    to: z.union([z.string(), z.array(z.string())]).describe("Recipient(s)"),
    subject: z.string().describe("Email subject"),
    html: z.string().optional().describe("HTML body"),
    text: z.string().optional().describe("Plain text body"),
    cc: z.union([z.string(), z.array(z.string())]).optional().describe("CC recipients"),
    bcc: z.union([z.string(), z.array(z.string())]).optional().describe("BCC recipients"),
    reply_to: z.string().optional().describe("Reply-to address"),
    provider_id: z.string().optional().describe("Provider ID (uses active provider if not specified)"),
    template: z.string().optional().describe("Template name to use"),
    template_vars: z.record(z.string()).optional().describe("Template variables"),
    scheduled_at: z.string().describe("ISO 8601 datetime to send the email"),
  },
  async (input) => {
    try {
      const { createScheduledEmail } = await import('../../db/scheduled.js');
      const { getTemplate, renderTemplate } = await import('../../db/templates.js');
      const { getActiveProvider } = await import('../../db/providers.js');
      const { resolveId } = await import('../helpers.js');
      let providerId: string;
      if (input.provider_id) {
        providerId = resolveId("providers", input.provider_id);
      } else {
        const active = getActiveProvider();
        providerId = active.id;
      }

      // Resolve template if provided
      let subject = input.subject;
      let html = input.html;
      let text = input.text;
      if (input.template) {
        const tpl = getTemplate(input.template);
        if (!tpl) throw new Error(`Template not found: ${input.template}`);
        const vars = input.template_vars || {};
        subject = renderTemplate(tpl.subject_template, vars);
        if (tpl.html_template) html = renderTemplate(tpl.html_template, vars);
        if (tpl.text_template) text = renderTemplate(tpl.text_template, vars);
      }

      // Recipient arrays are built EXACTLY as both deleted arms built them —
      // wrapped, not split. `addressList` (used by the send gate above) also
      // splits a comma-joined string and trims, which would arguably be a fix
      // here; it is deliberately not applied, because a collapse is not the place
      // to change what a queued row contains.
      const toArr = Array.isArray(input.to) ? input.to : [input.to];
      const ccArr = input.cc ? (Array.isArray(input.cc) ? input.cc : [input.cc]) : [];
      const bccArr = input.bcc ? (Array.isArray(input.bcc) ? input.bcc : [input.bcc]) : [];

      // `createScheduledEmail` reads the store seam and is async.
      const scheduled = await createScheduledEmail({
        provider_id: providerId,
        from_address: input.from,
        to_addresses: toArr,
        cc_addresses: ccArr,
        bcc_addresses: bccArr,
        reply_to: input.reply_to,
        subject,
        html,
        text_body: text,
        template_name: input.template,
        template_vars: input.template_vars,
        scheduled_at: input.scheduled_at,
      });

      return { content: [{ type: "text", text: JSON.stringify(scheduled, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
  );

  server.tool(
  "list_scheduled",
  "List scheduled emails",
  {
    status: z.enum(["pending", "sent", "cancelled", "failed"]).optional().describe("Filter by status"),
    limit: z.number().int().positive().max(1000).optional().describe("Maximum scheduled emails to return"),
    offset: z.number().int().min(0).optional().describe("Number of scheduled emails to skip"),
  },
  async ({ status, limit, offset }) => {
    try {
      const { listScheduledEmailSummaries } = await import('../../db/scheduled.js');
      const emails = await listScheduledEmailSummaries({
        ...(status ? { status } : {}),
        limit: limit ?? 100,
        offset: offset ?? 0,
      });
      return { content: [{ type: "text", text: JSON.stringify(emails, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
  );

  server.tool(
  "cancel_scheduled",
  "Cancel a pending scheduled email",
  {
    id: z.string().describe("Scheduled email ID (or prefix)"),
  },
  async ({ id }) => {
    try {
      const { cancelScheduledEmail } = await import('../../db/scheduled.js');
      const { resolveId } = await import('../helpers.js');
      const resolvedId = resolveId("scheduled_emails", id);
      const cancelled = await cancelScheduledEmail(resolvedId);
      if (!cancelled) throw new Error(`Cannot cancel email ${id} (may already be sent or cancelled)`);
      return { content: [{ type: "text", text: `Scheduled email cancelled: ${resolvedId}` }] };
    } catch (e) {
      return toolError(e);
    }
  },
  );

}
