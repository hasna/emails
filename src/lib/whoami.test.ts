// Client-side identity normalization — the idp principal class (ADR-0001/2)
// plus the pre-existing shapes it must not disturb.

import { describe, expect, it } from "bun:test";
import { describeIdentity, normalizeIdentity } from "./whoami.js";

describe("normalizeIdentity", () => {
  it("normalizes an IdP /v1/me body (principal_type, sub, tenant, scopes)", () => {
    const identity = normalizeIdentity({
      principal_type: "idp",
      sub: "sp-agent-1",
      tenant: { id: "t-1", slug: "acme", name: "Acme" },
      scopes: ["emails:read"],
    });
    expect(identity.principalType).toBe("idp");
    expect(identity.sub).toBe("sp-agent-1");
    expect(identity.tenant).toEqual({ id: "t-1", slug: "acme", name: "Acme" });
    expect(identity.scopes).toEqual(["emails:read"]);
    expect(identity.user).toBeNull();
  });

  it("keeps the api-key heuristic for bodies without a principal type", () => {
    const identity = normalizeIdentity({ kid: "hkid_1", scopes: ["emails:*"], tenant: { slug: "acme" } });
    expect(identity.principalType).toBe("apikey");
    expect(identity.sub).toBeNull();
  });

  it("keeps the user shape untouched", () => {
    const identity = normalizeIdentity({
      principal_type: "user",
      user: { id: "u1", email: "a@example.com", name: null },
      tenant: { id: "t-1", slug: "acme" },
      role: "owner",
      scopes: ["emails:read", "emails:write"],
      memberships: [{ tenant_id: "t-1", slug: "acme", role: "owner" }],
    });
    expect(identity.principalType).toBe("user");
    expect(identity.role).toBe("owner");
    expect(identity.memberships).toHaveLength(1);
  });
});

describe("describeIdentity", () => {
  it("labels an IdP principal with its org and short sub", () => {
    const identity = normalizeIdentity({
      principal_type: "idp",
      sub: "sp-agent-1",
      tenant: { id: "t-1", slug: "acme", name: "Acme" },
      scopes: ["emails:read"],
    });
    expect(describeIdentity(identity)).toBe("acme (idp agent sp-agent-1)");
  });
});
