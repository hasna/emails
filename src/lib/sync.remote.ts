import type { ProviderAdapter } from "../providers/interface.js";

// Provider event sync pulls remote delivery events (delivered/bounced/…) and
// ingests them into the local SQLite `emails`/`events` tables inside a
// transaction, updating contact bounce/complaint counts. In the self-hosted
// client there is no local event store — the operator's server pulls provider
// events and records them — so these ingestion entrypoints fail loud while
// preserving their signatures/return types.

export async function syncProvider(_providerId: string, _adapterOverride?: ProviderAdapter): Promise<number> {
  throw new Error(
    "syncProvider is not available in the self-hosted client; provider event ingestion runs on the self-hosted server.",
  );
}

export async function syncAll(): Promise<Record<string, number>> {
  throw new Error(
    "syncAll is not available in the self-hosted client; provider event ingestion runs on the self-hosted server.",
  );
}
