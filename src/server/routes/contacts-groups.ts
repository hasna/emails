// API route handlers — contacts-groups.ts
import { listContacts, suppressContact, unsuppressContact } from '../../db/contacts.js';
import { listTemplateSummaries, getTemplate, createTemplate, deleteTemplate } from '../../db/templates.js';
import { createSqliteEmailStore } from '../../store-sqlite/index.js';
import { getDatabase } from '../../db/database.js';
import { listGroups, createGroup, deleteGroup, getGroupByName, listMemberSummaries, getMember, addMember, removeMember } from '../../db/groups.js';
import { listScheduledEmailSummaries, cancelScheduledEmail } from '../../db/scheduled.js';
import { getEmailContent } from '../../db/email-content.js';
import { getAnalytics } from '../../lib/analytics.js';
import { exportEmailsCsv, exportEmailsJson, exportEventsCsv, exportEventsJson } from '../../lib/export.js';
import { json, notFound, badRequest, internalError, resolveId, resolveOptionalId, parseBody, queryInteger, queryPage } from './helpers.js';

const EXPORT_DEFAULT_LIMIT = 1000;
const EXPORT_MAX_LIMIT = 5000;

/**
 * The stores the `/api/contacts`, `/api/groups` and `/api/templates` routes read and
 * write through.
 *
 * This is the LOCAL DASHBOARD (`emails serve`), and the neighbouring imports in this
 * file are still local-SQLite modules reading the process-wide connection. When each
 * of these families collapsed onto the store seam its exports stopped requiring a
 * `Database` and started resolving the CONFIGURED store when given nothing — so passing
 * nothing here would have silently repointed these routes at an operator's API on any
 * installation configured for one. They therefore name the SQLite store bound to that
 * same connection, exactly as the `/api/sequences` routes do
 * (src/server/routes/inbound-sequences.ts). Built per request: the repositories are
 * thin wrappers over the memoised connection. One binding per family, so each set of
 * routes names its own store and no collapse leans on another's local alias.
 */
function localContactStore() {
  return createSqliteEmailStore({ database: getDatabase() });
}

function localGroupStore() {
  return createSqliteEmailStore({ database: getDatabase() });
}

function localTemplateStore() {
  return createSqliteEmailStore({ database: getDatabase() });
}

async function resolveGroupRef(raw: string): Promise<{ id: string } | null> {
  const ref = decodeURIComponent(raw);
  const group = await getGroupByName(ref, localGroupStore());
  if (group) return group;
  const id = resolveId("groups", ref);
  return id ? { id } : null;
}

export async function handle(req: Request, url: URL, path: string, method: string): Promise<Response | null> {
// ─── CONTACTS ──────────────────────────────────────────────────────────

// GET /api/contacts?suppressed=true|false
if (path === "/api/contacts" && method === "GET") {
  try {
    const suppressedParam = url.searchParams.get("suppressed");
    const opts = {
      ...(suppressedParam !== null ? { suppressed: suppressedParam === "true" } : {}),
      ...queryPage(url, 100),
    };
    // Reads the store seam (async). A table it could not enumerate to the end raises,
    // and lands on `internalError` below rather than being served as a short page.
    return json(await listContacts(opts, localContactStore()));
  } catch (e) { return internalError(e); }
}

// POST /api/contacts/:id/suppress
const contactSuppressMatch = path.match(/^\/api\/contacts\/([^/]+)\/suppress$/);
if (contactSuppressMatch && method === "POST") {
  try {
    await suppressContact(decodeURIComponent(contactSuppressMatch[1]!), localContactStore());
    return json({ ok: true });
  } catch (e) { return internalError(e); }
}

// POST /api/contacts/:id/unsuppress
const contactUnsuppressMatch = path.match(/^\/api\/contacts\/([^/]+)\/unsuppress$/);
if (contactUnsuppressMatch && method === "POST") {
  try {
    await unsuppressContact(decodeURIComponent(contactUnsuppressMatch[1]!), localContactStore());
    return json({ ok: true });
  } catch (e) { return internalError(e); }
}

// ─── TEMPLATES ─────────────────────────────────────────────────────────

// GET /api/templates
if (path === "/api/templates" && method === "GET") {
  try {
    // Reads the store seam (async). A library it could not enumerate to the end
    // raises, and lands on `internalError` below rather than being served as a
    // short page.
    return json(await listTemplateSummaries(queryPage(url, 100), localTemplateStore()));
  } catch (e) { return internalError(e); }
}

// POST /api/templates
if (path === "/api/templates" && method === "POST") {
  try {
    const body = await parseBody(req) as Record<string, unknown>;
    if (!body.name) return badRequest("name is required");
    if (!body.subject_template) return badRequest("subject_template is required");
    const template = await createTemplate({
      name: String(body.name),
      subject_template: String(body.subject_template),
      html_template: body.html_template as string | undefined,
      text_template: body.text_template as string | undefined,
    }, localTemplateStore());
    return json(template, 201);
  } catch (e) { return internalError(e); }
}

// GET /api/templates/:id
const templateMatch = path.match(/^\/api\/templates\/([^/]+)$/);
if (templateMatch && method === "GET") {
  try {
    const template = await getTemplate(decodeURIComponent(templateMatch[1]!), localTemplateStore());
    if (!template) return notFound("Template not found");
    return json(template);
  } catch (e) { return internalError(e); }
}

// DELETE /api/templates/:id
if (templateMatch && method === "DELETE") {
  try {
    const deleted = await deleteTemplate(decodeURIComponent(templateMatch[1]!), localTemplateStore());
    if (!deleted) return notFound("Template not found");
    return json({ ok: true });
  } catch (e) { return internalError(e); }
}

// ─── GROUPS ────────────────────────────────────────────────────────────

// GET /api/groups
if (path === "/api/groups" && method === "GET") {
  try {
    // Reads the store seam (async). A group list it could not enumerate to the end
    // raises, and lands on `internalError` below rather than being served short.
    return json(await listGroups(queryPage(url, 100), localGroupStore()));
  } catch (e) { return internalError(e); }
}

// POST /api/groups
if (path === "/api/groups" && method === "POST") {
  try {
    const body = await parseBody(req) as Record<string, unknown>;
    if (!body.name) return badRequest("name is required");
    const group = await createGroup(String(body.name), body.description as string | undefined, localGroupStore());
    return json(group, 201);
  } catch (e) { return internalError(e); }
}

// GET /api/groups/:id/members
const groupMembersMatch = path.match(/^\/api\/groups\/([^/]+)\/members$/);
if (groupMembersMatch && method === "GET") {
  try {
    const group = await resolveGroupRef(groupMembersMatch[1]!);
    if (!group) return notFound("Group not found");
    return json(await listMemberSummaries(group.id, queryPage(url, 100), localGroupStore()));
  } catch (e) { return internalError(e); }
}

// POST /api/groups/:id/members
if (groupMembersMatch && method === "POST") {
  try {
    const group = await resolveGroupRef(groupMembersMatch[1]!);
    if (!group) return notFound("Group not found");
    const body = await parseBody(req) as Record<string, unknown>;
    if (!body.email) return badRequest("email is required");
    const member = await addMember(group.id, String(body.email), body.name as string | undefined, undefined, localGroupStore());
    return json(member, 201);
  } catch (e) { return internalError(e); }
}

// DELETE /api/groups/:id/members/:email
const groupMemberDeleteMatch = path.match(/^\/api\/groups\/([^/]+)\/members\/([^/]+)$/);
if (groupMemberDeleteMatch && method === "GET") {
  try {
    const group = await resolveGroupRef(groupMemberDeleteMatch[1]!);
    if (!group) return notFound("Group not found");
    const member = await getMember(group.id, decodeURIComponent(groupMemberDeleteMatch[2]!), localGroupStore());
    if (!member) return notFound("Member not found");
    return json(member);
  } catch (e) { return internalError(e); }
}

if (groupMemberDeleteMatch && method === "DELETE") {
  try {
    const group = await resolveGroupRef(groupMemberDeleteMatch[1]!);
    if (!group) return notFound("Group not found");
    const removed = await removeMember(group.id, decodeURIComponent(groupMemberDeleteMatch[2]!), localGroupStore());
    if (!removed) return notFound("Member not found");
    return json({ ok: true });
  } catch (e) { return internalError(e); }
}

// DELETE /api/groups/:id
const groupMatch = path.match(/^\/api\/groups\/([^/]+)$/);
if (groupMatch && method === "DELETE") {
  try {
    const group = await resolveGroupRef(groupMatch[1]!);
    if (!group) return notFound("Group not found");
    await deleteGroup(group.id, localGroupStore());
    return json({ ok: true });
  } catch (e) { return internalError(e); }
}

// ─── SCHEDULED ─────────────────────────────────────────────────────────

// GET /api/scheduled?status=pending|sent|cancelled
if (path === "/api/scheduled" && method === "GET") {
  try {
    const statusParam = url.searchParams.get("status") as "pending" | "sent" | "cancelled" | null;
    const opts = {
      ...(statusParam ? { status: statusParam } : {}),
      ...queryPage(url, 100),
    };
    // Reads the store seam (async). A schedule it could not enumerate to the end raises,
    // and lands on `internalError` below rather than being served as a short page.
    return json(await listScheduledEmailSummaries(opts));
  } catch (e) { return internalError(e); }
}

// DELETE /api/scheduled/:id
const scheduledMatch = path.match(/^\/api\/scheduled\/([^/]+)$/);
if (scheduledMatch && method === "DELETE") {
  const id = resolveId("scheduled_emails", scheduledMatch[1]!);
  if (!id) return notFound();
  try {
    const cancelled = await cancelScheduledEmail(id);
    if (!cancelled) return badRequest("Cannot cancel email (may already be sent or cancelled)");
    return json({ ok: true });
  } catch (e) { return internalError(e); }
}

// ─── ANALYTICS ─────────────────────────────────────────────────────────

// GET /api/analytics?provider_id=x&period=30d
if (path === "/api/analytics" && method === "GET") {
  try {
    const period = url.searchParams.get("period") ?? "30d";
    const resolvedId = resolveOptionalId("providers", url.searchParams.get("provider_id"));
    // A `provider_id` is REFUSED rather than ignored: the store seam cannot scope
    // messages to a provider, so three of the four sections would cover every provider
    // while the response claimed one. The refusal is a 400, not a 500, because the
    // request is the thing that is wrong.
    if (resolvedId) {
      return badRequest(
        "provider_id is not supported: the store seam cannot scope messages to a provider, so a " +
          "provider-scoped report would cover every provider in its volume, recipient and hour " +
          "sections. Omit provider_id.",
      );
    }
    return json(await getAnalytics(undefined, period));
  } catch (e) { return internalError(e); }
}

// ─── EMAIL CONTENT ──────────────────────────────────────────────────────

// GET /api/email-content/:id
const emailContentMatch = path.match(/^\/api\/email-content\/([^/]+)$/);
if (emailContentMatch && method === "GET") {
  const id = resolveId("emails", emailContentMatch[1]!);
  if (!id) return notFound();
  try {
    // NULL NOW MEANS "NO SUCH MESSAGE" AND ONLY THAT. It used to also mean "the message is
    // here but carries no body row", which answered 404 for a message this route had just
    // resolved an id for. A message with an empty body is now a 200 whose html and text are
    // null; a store that REFUSED raises and is answered by `internalError` below, because a
    // refusal is not a not-found.
    const content = await getEmailContent(id);
    if (!content) return notFound("Email content not found");
    return json(content);
  } catch (e) { return internalError(e); }
}

// ─── EXPORT ────────────────────────────────────────────────────────────

// GET /api/export/emails?format=csv|json&provider_id=x&since=...
if (path === "/api/export/emails" && method === "GET") {
  try {
    const format = url.searchParams.get("format") ?? "json";
    const providerId = resolveOptionalId("providers", url.searchParams.get("provider_id"));
    const fromAddress = url.searchParams.get("from_address") ?? url.searchParams.get("from") ?? undefined;
    const since = url.searchParams.get("since") ?? undefined;
    const until = url.searchParams.get("until") ?? undefined;
    const limit = queryInteger(url, "limit", EXPORT_DEFAULT_LIMIT, { min: 1, max: EXPORT_MAX_LIMIT });
    const offset = queryInteger(url, "offset", 0, { min: 0 });
    const filters = { provider_id: providerId, from_address: fromAddress, since, until, limit, offset };
    if (format === "csv") {
      return new Response(await exportEmailsCsv(filters), {
        headers: { "Content-Type": "text/csv", "X-Export-Limit": String(limit), "X-Export-Offset": String(offset) },
      });
    }
    return new Response(await exportEmailsJson(filters), {
      headers: { "Content-Type": "application/json", "X-Export-Limit": String(limit), "X-Export-Offset": String(offset) },
    });
  } catch (e) { return internalError(e); }
}

// GET /api/export/events?format=csv|json&provider_id=x&since=...
if (path === "/api/export/events" && method === "GET") {
  try {
    const format = url.searchParams.get("format") ?? "json";
    const providerId = resolveOptionalId("providers", url.searchParams.get("provider_id"));
    const since = url.searchParams.get("since") ?? undefined;
    const until = url.searchParams.get("until") ?? undefined;
    const limit = queryInteger(url, "limit", EXPORT_DEFAULT_LIMIT, { min: 1, max: EXPORT_MAX_LIMIT });
    const offset = queryInteger(url, "offset", 0, { min: 0 });
    const filters = { provider_id: providerId, since, until, limit, offset };
    if (format === "csv") {
      return new Response(await exportEventsCsv(filters), {
        headers: { "Content-Type": "text/csv", "X-Export-Limit": String(limit), "X-Export-Offset": String(offset) },
      });
    }
    return new Response(await exportEventsJson(filters), {
      headers: { "Content-Type": "application/json", "X-Export-Limit": String(limit), "X-Export-Offset": String(offset) },
    });
  } catch (e) { return internalError(e); }
}

  return null;
}
