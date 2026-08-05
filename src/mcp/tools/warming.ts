import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createWarmingSchedule, getWarmingSchedule, listWarmingSchedules, updateWarmingStatus } from "../../db/warming.js";
import { describeWarmingProgress, generateWarmingPlan } from "../../lib/warming.js";
import { formatError } from "../helpers.js";

// Warming schedules are a repository resource in every configuration (local
// SQLite `warming_schedules`, `/v1/warming` on the self-hosted server), so these
// tools call the collapsed warming family (src/db/warming.ts) directly — one
// async implementation over the store seam, resolved from storage configuration.
// They are the MCP twins of `emails domain warm*`.
export function registerWarmingTools(server: McpServer): void {
  server.tool(
    "create_warming_schedule",
    "Create a domain warming schedule to gradually ramp up email send volume",
    {
      domain: z.string().describe("Domain to warm up (e.g. example.com)"),
      target_daily_volume: z.number().describe("Target daily send volume to reach"),
      start_date: z.string().optional().describe("Start date in YYYY-MM-DD format (default: today)"),
      provider_id: z.string().optional().describe("Provider ID to associate with this domain"),
    },
    async ({ domain, target_daily_volume, start_date, provider_id }) => {
      try {
        // Same duplicate guard as `emails domain warm`: the /v1 store accepts a
        // second POST for the same domain, which would leave two schedules and
        // make which one the reads see arbitrary.
        const existing = await getWarmingSchedule(domain);
        if (existing) {
          throw new Error(
            `${domain} already has a warming schedule (status ${existing.status}, target ${existing.target_daily_volume}/day, started ${existing.start_date}). ` +
              "Use update_warming_status to change its state, or delete it first to retarget.",
          );
        }
        const schedule = await createWarmingSchedule({ domain, target_daily_volume, start_date, provider_id });
        const plan = generateWarmingPlan(target_daily_volume);
        return { content: [{ type: "text", text: JSON.stringify({ schedule, plan_days: plan.length, final_day: plan[plan.length - 1]?.day }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
      }
    },
  );

  server.tool(
    "get_warming_status",
    "Get current warming status for a domain including today's limit and sent count",
    { domain: z.string().describe("Domain to check") },
    async ({ domain }) => {
      try {
        const schedule = await getWarmingSchedule(domain);
        if (!schedule) throw new Error(`Warming schedule not found for domain: ${domain}`);
        const { today_limit, today_sent, current_day } = await describeWarmingProgress(schedule);
        return { content: [{ type: "text", text: JSON.stringify({ schedule, today_limit, today_sent, current_day }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
      }
    },
  );

  server.tool(
    "list_warming_schedules",
    "List all domain warming schedules",
    {
      status: z.enum(["active", "paused", "completed"]).optional().describe("Filter by status"),
      limit: z.number().int().positive().max(1000).optional().describe("Maximum schedules to return"),
      offset: z.number().int().min(0).optional().describe("Number of schedules to skip"),
    },
    async ({ status, limit, offset }) => {
      try {
        const effectiveLimit = limit ?? 100;
        const effectiveOffset = offset ?? 0;
        const rows = await listWarmingSchedules(status, { limit: effectiveLimit + 1, offset: effectiveOffset });
        const schedules = rows.slice(0, effectiveLimit);
        return { content: [{ type: "text", text: JSON.stringify({
          schedules,
          limit: effectiveLimit,
          offset: effectiveOffset,
          truncated: rows.length > effectiveLimit,
          cli_equivalent: `emails domain warm-list${status ? ` --status ${status}` : ""}${limit !== undefined ? ` --limit ${limit}` : ""}${offset !== undefined ? ` --offset ${offset}` : ""} --json`,
        }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
      }
    },
  );

  server.tool(
    "update_warming_status",
    "Update the status of a domain warming schedule",
    {
      domain: z.string().describe("Domain to update"),
      status: z.enum(["active", "paused", "completed"]).describe("New status"),
    },
    async ({ domain, status }) => {
      try {
        const updated = await updateWarmingStatus(domain, status);
        if (!updated) throw new Error(`Warming schedule not found for domain: ${domain}`);
        return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
      }
    },
  );
}
