import type { Database } from "../db/database.js";
import * as local from "./doctor.local.js";
import * as remote from "./doctor.remote.js";
import { getEmailsMode } from "./mode.js";

export { formatDiagnostics } from "./diagnostics-format.js";
export type { DoctorCheck } from "./diagnostics-format.js";
export type { DiagnosticsOptions } from "./doctor.local.js";

function isDatabase(value: unknown): value is Database {
  return typeof value === "object" && value !== null && "query" in value;
}

export async function runDiagnostics(
  dbOrOptions?: Database | local.DiagnosticsOptions,
  options: local.DiagnosticsOptions = {},
): Promise<import("./diagnostics-format.js").DoctorCheck[]> {
  const db = isDatabase(dbOrOptions) ? dbOrOptions : undefined;
  const resolvedOptions = isDatabase(dbOrOptions) ? options : (dbOrOptions ?? options);
  return getEmailsMode() === "self_hosted"
    ? remote.runDiagnostics(resolvedOptions)
    : local.runDiagnostics(db, resolvedOptions);
}
