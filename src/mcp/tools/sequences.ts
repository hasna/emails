import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const MAX_MCP_REPLY_LIMIT = 100;

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

async function toolError(error: unknown): Promise<ToolResult> {
  const { formatError } = await import("../helpers.js");
  return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
}

async function isSelfHostedRuntimeMode(): Promise<boolean> {
  const { resolveEmailsMode } = await import("../../lib/mode.js");
  return resolveEmailsMode().mode === "self_hosted";
}

async function assertSelfHostedApiRouteReady(toolName: string): Promise<void> {
  if (!(await isSelfHostedRuntimeMode())) return;
  const { isSelfHostedMode } = await import("../../db/self-hosted-store.js");
  if (!isSelfHostedMode()) {
    throw new Error(
      `MCP tool ${toolName} is API-backed in self_hosted mode and requires EMAILS_MODE=self_hosted with ` +
        "EMAILS_SELF_HOSTED_URL and EMAILS_SELF_HOSTED_API_KEY. Set EMAILS_MODE=local only for an explicit local sequence store.",
    );
  }
}

export function registerSequenceTools(server: McpServer): void {
// ─── SEQUENCES ────────────────────────────────────────────────────────────────

  server.tool(
  "list_sequences",
  "List all email drip sequences",
  {
    limit: z.number().int().positive().max(1000).optional().describe("Maximum sequences to return"),
    offset: z.number().int().min(0).optional().describe("Number of sequences to skip"),
  },
  async ({ limit, offset }) => {
    try {
      await assertSelfHostedApiRouteReady("list_sequences");
      const { listSequences } = await import("../../db/sequences.js");
      const sequences = await listSequences({ limit: limit ?? 100, offset: offset ?? 0 });
      return { content: [{ type: "text", text: JSON.stringify(sequences, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
);

  server.tool(
  "create_sequence",
  "Create a new email drip sequence",
  {
    name: z.string().describe("Unique sequence name"),
    description: z.string().optional().describe("Sequence description"),
  },
  async ({ name, description }) => {
    try {
      await assertSelfHostedApiRouteReady("create_sequence");
      const { createSequence } = await import("../../db/sequences.js");
      const sequence = await createSequence({ name, description });
      return { content: [{ type: "text", text: JSON.stringify(sequence, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
);

  // Sequence steps and enrollments are repository resources in every configuration
  // (local SQLite, `/v1/sequence-steps` and `/v1/sequence-enrollments` on the
  // self-hosted server), and src/db/sequences.remote.ts is a complete client for
  // both. The four step/enrollment tools below therefore carry no mode guard — they
  // are the MCP twins of `emails sequence step add|enroll|unenroll|enrollments`,
  // which already perform the same operations over the same route.
  server.tool(
  "add_sequence_step",
  "Add a step to an email sequence",
  {
    sequence_id: z.string().describe("Sequence ID or name"),
    step_number: z.number().describe("Step number (1, 2, 3...)"),
    delay_hours: z.number().describe("Delay in hours before sending this step"),
    template_name: z.string().describe("Template name to use for this step"),
    from_address: z.string().optional().describe("From address override"),
    subject_override: z.string().optional().describe("Subject override"),
  },
  async ({ sequence_id, step_number, delay_hours, template_name, from_address, subject_override }) => {
    try {
      const { getSequence, addStep } = await import("../../db/sequences.js");
      const seq = await getSequence(sequence_id);
      if (!seq) throw new Error(`Sequence not found: ${sequence_id}`);
      const step = await addStep({
        sequence_id: seq.id,
        step_number,
        delay_hours,
        template_name,
        from_address,
        subject_override,
      });
      return { content: [{ type: "text", text: JSON.stringify(step, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
);

  server.tool(
  "enroll_contact",
  "Enroll a contact in an email sequence",
  {
    sequence_id: z.string().describe("Sequence ID or name"),
    contact_email: z.string().describe("Contact email address"),
    provider_id: z.string().optional().describe("Provider ID to use for sending"),
  },
  async ({ sequence_id, contact_email, provider_id }) => {
    try {
      const { getSequence, enroll } = await import("../../db/sequences.js");
      const seq = await getSequence(sequence_id);
      if (!seq) throw new Error(`Sequence not found: ${sequence_id}`);
      const enrollment = await enroll({ sequence_id: seq.id, contact_email, provider_id });
      return { content: [{ type: "text", text: JSON.stringify(enrollment, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
);

  server.tool(
  "unenroll_contact",
  "Unenroll a contact from an email sequence",
  {
    sequence_id: z.string().describe("Sequence ID or name"),
    contact_email: z.string().describe("Contact email address"),
  },
  async ({ sequence_id, contact_email }) => {
    try {
      const { getSequence, unenroll } = await import("../../db/sequences.js");
      const seq = await getSequence(sequence_id);
      if (!seq) throw new Error(`Sequence not found: ${sequence_id}`);
      const removed = await unenroll(seq.id, contact_email);
      return { content: [{ type: "text", text: removed ? "Contact unenrolled" : "Contact was not actively enrolled" }] };
    } catch (e) {
      return toolError(e);
    }
  },
);

  server.tool(
  "list_enrollments",
  "List sequence enrollments, optionally filtered by sequence",
  {
    sequence_id: z.string().optional().describe("Sequence ID or name to filter by"),
    status: z.enum(["active", "completed", "cancelled"]).optional().describe("Filter by enrollment status"),
    limit: z.number().int().positive().max(1000).optional().describe("Maximum enrollments to return"),
    offset: z.number().int().min(0).optional().describe("Number of enrollments to skip"),
  },
  async ({ sequence_id, status, limit, offset }) => {
    try {
      const { getSequence, listEnrollments } = await import("../../db/sequences.js");
      let resolvedSequenceId: string | undefined;
      if (sequence_id) {
        const seq = await getSequence(sequence_id);
        if (!seq) throw new Error(`Sequence not found: ${sequence_id}`);
        resolvedSequenceId = seq.id;
      }
      const enrollments = await listEnrollments({
        sequence_id: resolvedSequenceId,
        status,
        limit: limit ?? 100,
        offset: offset ?? 0,
      });
      return { content: [{ type: "text", text: JSON.stringify(enrollments, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
);

// ─── REPLY TRACKING ───────────────────────────────────────────────────────────

  server.tool(
  "list_replies",
  "List inbound emails received as replies to a sent email",
  {
    email_id: z.string().describe("ID of the sent email to find replies for"),
    limit: z.number().int().positive().max(MAX_MCP_REPLY_LIMIT).optional().describe("Maximum replies to return (default 20, max 100)"),
    offset: z.number().int().min(0).optional().describe("Number of replies to skip"),
  },
  async ({ email_id, limit, offset }) => {
    try {
      // This refused unconditionally, in EVERY mode, claiming "inbound reply
      // tracking runs on the self-hosted server" and that no API-backed
      // implementation existed. Both halves were false: src/db/inbound.ts routes
      // `listReplySummaries`/`getReplyCount` to inbound.remote.ts, which serves them
      // from the `/v1/messages` list+get routes, and the CLI twin
      // `emails replies <id>` (src/cli/commands/email-log.remote.ts) has always run
      // in self_hosted mode over the same data. A refusal in front of a working
      // route in BOTH modes is strictly worse than the mode-conditional guards —
      // those at least told the truth in local mode.
      const { listReplySummaries, getReplyCount } = await import("../../db/inbound.js");
      const effectiveLimit = limit ?? 20;
      const effectiveOffset = offset ?? 0;
      const replies = listReplySummaries(email_id, { limit: effectiveLimit, offset: effectiveOffset });
      return { content: [{ type: "text", text: JSON.stringify({
        replies,
        total: getReplyCount(email_id),
        limit: effectiveLimit,
        offset: effectiveOffset,
      }, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
);

}
