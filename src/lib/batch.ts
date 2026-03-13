import { readFileSync } from "fs";
import { getAdapter } from "../providers/index.js";
import { getTemplateByName, renderTemplate } from "../db/templates.js";
import { createEmail } from "../db/emails.js";
import { isContactSuppressed, incrementSendCount, upsertContact } from "../db/contacts.js";
import type { Provider } from "../types/index.js";

export interface BatchResult {
  total: number;
  sent: number;
  failed: number;
  suppressed: number;
  errors: { email: string; error: string }[];
}

export function parseCsv(content: string): Record<string, string>[] {
  const lines = content.trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0]!.split(",").map(h => h.trim());
  return lines.slice(1).map(line => {
    const values = line.split(",").map(v => v.trim());
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = values[i] || ""; });
    return row;
  });
}

export async function batchSend(opts: {
  csvPath: string;
  templateName: string;
  from: string;
  provider: Provider;
  force?: boolean;
  /** @internal for testing — inject an adapter instead of resolving from provider */
  _adapter?: { sendEmail: (opts: unknown) => Promise<string | undefined> };
  /** @internal for testing — inject CSV content instead of reading from file */
  _csvContent?: string;
}): Promise<BatchResult> {
  const csvContent = opts._csvContent ?? readFileSync(opts.csvPath, "utf-8");
  const rows = parseCsv(csvContent);

  const template = getTemplateByName(opts.templateName);
  if (!template) {
    throw new Error(`Template not found: ${opts.templateName}`);
  }

  const adapter = opts._adapter ?? getAdapter(opts.provider);
  const result: BatchResult = { total: rows.length, sent: 0, failed: 0, suppressed: 0, errors: [] };

  for (const row of rows) {
    const email = row["email"];
    if (!email) {
      result.failed++;
      result.errors.push({ email: "(missing)", error: "Row missing 'email' column" });
      continue;
    }

    // Check suppression
    if (!opts.force && isContactSuppressed(email)) {
      result.suppressed++;
      continue;
    }

    try {
      const vars = row as Record<string, string>;
      const subject = renderTemplate(template.subject_template, vars);
      const html = template.html_template ? renderTemplate(template.html_template, vars) : undefined;
      const text = template.text_template ? renderTemplate(template.text_template, vars) : undefined;

      const sendOpts = {
        from: opts.from,
        to: email,
        subject,
        html,
        text,
      };

      const messageId = await adapter.sendEmail(sendOpts);
      createEmail(opts.provider.id, sendOpts, messageId);

      // Track contact
      upsertContact(email);
      incrementSendCount(email);

      result.sent++;
    } catch (err) {
      result.failed++;
      result.errors.push({ email, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}
