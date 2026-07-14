import type { Provider } from "../types/index.js";

export { parseCsv } from "./csv.js";

export interface BatchResult {
  total: number;
  sent: number;
  failed: number;
  suppressed: number;
  errors: { email: string; error: string }[];
}

// Batch send renders a local template per CSV row, checks the local contact
// suppression list, sends through the local provider adapters (with failover),
// and writes each result to the local sent-mail ledger. All of that is
// server-side in the self-hosted client (sending goes through the authenticated
// `/v1` send endpoint via the mail data source). This stub preserves the
// signature/return type and fails loud.
export async function batchSend(_opts: {
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
  throw new Error(
    "batchSend is not available in the self-hosted client; template batch sending runs on the self-hosted server via the authenticated /v1 send endpoint.",
  );
}
