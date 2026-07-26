// Every `/v1` list must page over a TOTAL order.
//
// THE DEFECT THIS GUARDS: the generic resource lister ordered by `spec.orderBy`
// alone. Most of those clauses are not unique (`created_at DESC`;
// `status ASC, type ASC, created_at ASC` for sources), and SQL gives no guarantee
// about the relative order of tied rows — nor that two queries break the tie the
// same way. So `LIMIT/OFFSET` paging could return one row on two pages and never
// return another.
//
// Measured against production on 2026-07-26: paging `/v1/sources` at limit=500
// returned 3899 rows of which only 3473 were distinct, while the table held 3899.
// The CLI de-duplicated and published 3473 as `sources.configured.total` with
// `complete: true` — an 11% undercount that read as authoritative. Appending the
// resource's primary key makes each row's sort position unique.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SELF_HOSTED_RESOURCES,
  resourceKeyColumn,
  resourceListOrderBy,
  resourceSpecForPath,
  type SelfHostedResourceSpec,
} from "./resources.js";

function orderTerms(clause: string): string[] {
  return clause.split(",").map((term) => term.trim().split(/\s+/)[0] ?? "");
}

describe("resourceListOrderBy", () => {
  it("makes EVERY registered resource's list order total", () => {
    const notTotal: string[] = [];
    for (const spec of SELF_HOSTED_RESOURCES) {
      const terms = orderTerms(resourceListOrderBy(spec));
      if (!terms.includes(resourceKeyColumn(spec))) notTotal.push(spec.path);
    }
    expect(notTotal, "these resources page over a non-unique sort, so offset paging "
      + "can return duplicates and skip rows").toEqual([]);
  });

  it("appends the primary key to a non-unique clause", () => {
    const sources = resourceSpecForPath("sources");
    expect(sources?.orderBy).toBe("status ASC, type ASC, created_at ASC");
    expect(resourceListOrderBy(sources as SelfHostedResourceSpec))
      .toBe("status ASC, type ASC, created_at ASC, id ASC");
  });

  it("uses the resource's own key column, not a hardcoded `id`", () => {
    // email-agents is keyed by agent_key, so `id` would not disambiguate it.
    const keyed = SELF_HOSTED_RESOURCES.find((spec) => spec.idColumn && spec.idColumn !== "id");
    expect(keyed, "fixture: at least one resource has a non-`id` key").toBeDefined();
    const clause = resourceListOrderBy(keyed as SelfHostedResourceSpec);
    expect(orderTerms(clause)).toContain((keyed as SelfHostedResourceSpec).idColumn);
  });

  it("does not duplicate a key the clause already sorts by", () => {
    const spec: SelfHostedResourceSpec = { path: "x", table: "x", orderBy: "id ASC", columns: [] };
    expect(resourceListOrderBy(spec)).toBe("id ASC");
  });

  // The bespoke domain/address listers do not go through the registry, so the
  // registry test above cannot see them. They are the two lists `emails status`
  // counts from, i.e. exactly where an unstable window becomes a wrong total.
  it("keeps the bespoke domain/address list queries totally ordered", () => {
    const store = readFileSync(join(import.meta.dir, "store.ts"), "utf8");
    for (const table of ["domains", "addresses"]) {
      const pattern = new RegExp(
        `SELECT \\* FROM ${table} WHERE tenant_id = \\$1 ORDER BY ([^\`]*?) LIMIT`,
      );
      const match = store.match(pattern);
      expect(match, `${table} list query not found`).not.toBeNull();
      expect(orderTerms(match?.[1] ?? ""), `${table} list must page over a total order`)
        .toContain("id");
    }
  });
});
