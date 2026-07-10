// Live conformance test: drives the domains REPOSITORY (createDomain/getDomain/
// listDomains/deleteDomain) with the client flipped to self_hosted, proving the
// repo layer routes reads+writes to the selfHosted HTTP API. Skips cleanly when the
// selfHosted env is not configured.
//
// Enable by exporting:
//   EMAILS_MODE=self_hosted
//   EMAILS_SELF_HOSTED_URL=https://emails.example
//   EMAILS_SELF_HOSTED_API_KEY=<key>

import { describe, expect, test } from "bun:test";
import { createDomain, deleteDomain, getDomain, getDomainByName, listDomains } from "./domains.js";
import { resetSelfHostedConfigCache } from "./self-hosted-store.js";

const HAS_CLOUD =
  Boolean(process.env.EMAILS_SELF_HOSTED_URL || process.env.EMAILS_SELF_HOSTED_URL) &&
  Boolean(process.env.EMAILS_SELF_HOSTED_API_KEY || process.env.EMAILS_SELF_HOSTED_API_KEY) &&
  /selfHosted|self_hosted|remote|hybrid/i.test(
    process.env.EMAILS_MODE ?? process.env.EMAILS_STORAGE_MODE ?? process.env.HASNA_EMAILS_MODE ?? "",
  );

const maybe = HAS_CLOUD ? test : test.skip;

describe("live selfHosted domains CRUD via repository (self_hosted)", () => {
  maybe("create -> get -> list -> delete round-trips against the selfHosted API", () => {
    resetSelfHostedConfigCache();
    const name = `live-repo-probe-${Date.now()}.example.com`;

    const created = createDomain("selfHosted", name);
    expect(created.id).toBeTruthy();
    expect(created.domain).toBe(name);

    const fetched = getDomain(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.domain).toBe(name);

    const byName = getDomainByName("selfHosted", name);
    expect(byName?.id).toBe(created.id);

    const listed = listDomains();
    expect(listed.some((dm) => dm.id === created.id)).toBe(true);

    const deleted = deleteDomain(created.id);
    expect(deleted).toBe(true);
    expect(getDomain(created.id)).toBeNull();
  });
});
