// Live conformance test: drives the domains REPOSITORY (createDomain/getDomain/
// listDomains/deleteDomain) with the client flipped to self_hosted, proving the
// repo layer routes reads+writes to the cloud HTTP API. Skips cleanly when the
// cloud env is not configured.
//
// Enable by exporting:
//   HASNA_MAILERY_STORAGE_MODE=self_hosted
//   HASNA_MAILERY_API_URL=https://mailery.hasna.xyz
//   HASNA_MAILERY_API_KEY=<key>

import { describe, expect, test } from "bun:test";
import { createDomain, deleteDomain, getDomain, getDomainByName, listDomains } from "./domains.js";
import { resetCloudConfigCache } from "./cloud-store.js";

const HAS_CLOUD =
  Boolean(process.env.HASNA_MAILERY_API_URL || process.env.MAILERY_API_URL) &&
  Boolean(process.env.HASNA_MAILERY_API_KEY || process.env.MAILERY_API_KEY) &&
  /cloud|self_hosted|remote|hybrid/i.test(
    process.env.HASNA_MAILERY_STORAGE_MODE ?? process.env.MAILERY_STORAGE_MODE ?? process.env.HASNA_EMAILS_MODE ?? "",
  );

const maybe = HAS_CLOUD ? test : test.skip;

describe("live cloud domains CRUD via repository (self_hosted)", () => {
  maybe("create -> get -> list -> delete round-trips against the cloud API", () => {
    resetCloudConfigCache();
    const name = `live-repo-probe-${Date.now()}.example.com`;

    const created = createDomain("cloud", name);
    expect(created.id).toBeTruthy();
    expect(created.domain).toBe(name);

    const fetched = getDomain(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.domain).toBe(name);

    const byName = getDomainByName("cloud", name);
    expect(byName?.id).toBe(created.id);

    const listed = listDomains();
    expect(listed.some((dm) => dm.id === created.id)).toBe(true);

    const deleted = deleteDomain(created.id);
    expect(deleted).toBe(true);
    expect(getDomain(created.id)).toBeNull();
  });
});
