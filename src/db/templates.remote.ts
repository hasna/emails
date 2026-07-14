import { selfHostedResource, selfHostedListQuery, selfHostedPage, cobj, ciso, cstr, cstrOrNull } from "./self-hosted-resource.js";

const TEMPLATE_RESOURCE = "templates";

export interface Template {
  id: string;
  name: string;
  subject_template: string;
  html_template: string | null;
  text_template: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type TemplateSummary = Omit<Template, "html_template" | "text_template"> & {
  has_html_template: boolean;
  has_text_template: boolean;
};

export interface ListTemplateOptions {
  limit?: number;
  offset?: number;
}

function apiToTemplate(e: Record<string, unknown>): Template {
  const updatedAt = ciso(e["updated_at"]);
  return {
    id: cstr(e["id"]),
    name: cstr(e["name"]),
    subject_template: cstr(e["subject_template"]),
    html_template: cstrOrNull(e["html_template"]),
    text_template: cstrOrNull(e["text_template"]),
    metadata: cobj(e["metadata"]),
    created_at: ciso(e["created_at"], updatedAt),
    updated_at: updatedAt,
  };
}

function templateToSummary(t: Template): TemplateSummary {
  return {
    id: t.id,
    name: t.name,
    subject_template: t.subject_template,
    metadata: t.metadata,
    has_html_template: Boolean(t.html_template && t.html_template !== ""),
    has_text_template: Boolean(t.text_template && t.text_template !== ""),
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

export function createTemplate(
  input: {
    name: string;
    subject_template: string;
    html_template?: string;
    text_template?: string;
  },
): Template {
  return apiToTemplate(selfHostedResource(TEMPLATE_RESOURCE).create({
    name: input.name,
    subject_template: input.subject_template,
    html_template: input.html_template || null,
    text_template: input.text_template || null,
    metadata: {},
  }));
}

export function getTemplate(nameOrId: string): Template | null {
  // The API exposes get-by-id, so a name lookup falls back to a bounded list scan.
  const store = selfHostedResource(TEMPLATE_RESOURCE);
  const direct = store.get(nameOrId);
  if (direct) return apiToTemplate(direct);
  const match = store.list({ limit: 1000 }).map(apiToTemplate).find((t) => t.name === nameOrId);
  return match ?? null;
}

export function getTemplateByName(name: string): Template | null {
  return selfHostedResource(TEMPLATE_RESOURCE).list({ limit: 1000 }).map(apiToTemplate).find((t) => t.name === name) ?? null;
}

export function listTemplates(opts?: ListTemplateOptions): Template[] {
  const { query, limit, offset } = selfHostedListQuery(opts);
  const rows = selfHostedResource(TEMPLATE_RESOURCE).list(query).map(apiToTemplate);
  rows.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return selfHostedPage(rows, limit, offset);
}

export function listTemplateSummaries(opts?: ListTemplateOptions): TemplateSummary[] {
  const { query, limit, offset } = selfHostedListQuery(opts);
  const rows = selfHostedResource(TEMPLATE_RESOURCE).list(query).map(apiToTemplate).map(templateToSummary);
  rows.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return selfHostedPage(rows, limit, offset);
}

export function deleteTemplate(nameOrId: string): boolean {
  // Resolve name -> id first (the API deletes by id only), then DELETE.
  const existing = getTemplate(nameOrId);
  if (!existing) return false;
  return selfHostedResource(TEMPLATE_RESOURCE).del(existing.id);
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    return vars[key] ?? `{{${key}}}`;
  });
}
