import { describe, expect, it } from "bun:test";
import { ServiceContractManifestSchema } from "@hasna/contracts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import contract from "../hasna.contract.json" with { type: "json" };
import { EMAILS_MODE_ENV_KEYS, resolveEmailsModeSelection } from "./lib/mode.js";
import { emailsSelfHostedOpenApi } from "./server/self-hosted/openapi.js";
import { SELF_HOSTED_APP, SELF_HOSTED_APP_ALIASES } from "./server/self-hosted/env.js";

const root = join(import.meta.dir, "..");

// Canonical published identity.
//
// @hasna/emails is the canonical package for this repository and owns the
// emails/emails-mcp/emails-serve bins. @hasna/mailery is an abandoned package
// line and must not be revived by publishing this tree under that name.
//
// These assertions pin the package identity independently of release-version
// history or the separate cloud CLI.
const CANONICAL_PACKAGE = "@hasna/emails";
const CANONICAL_REPOSITORY = "git+https://github.com/hasna/emails.git";
const CANONICAL_BINS = ["emails", "emails-mcp", "emails-serve"];

describe("published package identity", () => {
  it("publishes as @hasna/emails from the hasna/emails repository", () => {
    expect(pkg.name).toBe(CANONICAL_PACKAGE);
    expect(pkg.repository.url).toBe(CANONICAL_REPOSITORY);
  });

  it("ships only the emails* bins and leaves mailery* free for the cloud CLI", () => {
    expect(Object.keys(pkg.bin)).toEqual(CANONICAL_BINS);
  });

  it("declares the same identity in the service contract", () => {
    expect(contract.name).toBe("emails");
    expect(contract.bins).toEqual(CANONICAL_BINS);
    expect(contract.metadata.migrateCommand).toEqual(["emails", "db", "migrate"]);
  });

  it("tracks a manifest accepted by the installed contracts schema", () => {
    expect(pkg.dependencies["@hasna/contracts"]).toBe(contract.kitVersion);
    const result = ServiceContractManifestSchema.safeParse(contract);
    if (!result.success) throw new Error(result.error.message);

    expect(contract.storage.mode).toBe("sqlite");
    expect(contract.storage.engines).toEqual(["sqlite", "postgres"]);
    expect(contract.serviceSurfaces.every((surface) => !("deploymentModes" in surface))).toBe(true);
  });

  it("declares the readiness probe public when OpenAPI does", () => {
    const api = contract.serviceSurfaces.find((surface) => surface.kind === "api");
    expect(api?.readiness).toEqual({ method: "GET", path: "/ready", public: true });
    expect(emailsSelfHostedOpenApi.paths["/ready"]?.get?.security).toEqual([]);
  });

  it("asserts the canonical identity in CI", () => {
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain(`pkg.name !== "${CANONICAL_PACKAGE}"`);
    expect(ci).toContain(`pkg.repository?.url !== "${CANONICAL_REPOSITORY}"`);
    expect(ci).not.toContain("@hasna/mailery");
  });

  it("packs only paths the build actually produces", () => {
    // "dist" is produced by `bun run build`; every other packed path must exist
    // in the tree. `dashboard/dist` satisfied neither: no script or CI step ever
    // produced it and no code read it.
    for (const entry of pkg.files) {
      if (entry === "dist") continue;
      expect({ entry, exists: existsSync(join(root, entry)) }).toEqual({ entry, exists: true });
    }
  });
});

describe("api-key app slug", () => {
  it("mints under the canonical emails slug and still verifies mailery-era keys", () => {
    // The unreleased rename minted keys under "mailery". Those keep verifying as
    // an alias; new keys carry the canonical slug again.
    expect(SELF_HOSTED_APP).toBe("emails");
    expect([...SELF_HOSTED_APP_ALIASES]).toEqual(["mailery"]);
  });

  it("keeps the contract's api-key app aligned with the server", () => {
    expect(contract.metadata.apiKeyApp).toBe(SELF_HOSTED_APP);
    expect(contract.metadata.apiKeyAppAliases).toEqual([...SELF_HOSTED_APP_ALIASES]);
  });
});

describe("MAILERY_* environment surface", () => {
  it("has no startup env bridge", () => {
    expect(existsSync(join(root, "src/lib/env-compat.ts"))).toBe(false);
    expect(existsSync(join(root, "src/lib/env-compat.test.ts"))).toBe(false);
  });

  it("selects the mode from EMAILS_* names only", () => {
    expect([...EMAILS_MODE_ENV_KEYS]).toEqual(["EMAILS_MODE", "HASNA_EMAILS_MODE"]);
  });

  it("rejects MAILERY_MODE / HASNA_MAILERY_MODE as removed-runtime variables", () => {
    for (const key of ["MAILERY_MODE", "HASNA_MAILERY_MODE"]) {
      expect(() => resolveEmailsModeSelection({ [key]: "self_hosted" })).toThrow(/removed hosted\/legacy runtime/);
    }
  });
});

describe("superseded and dead scaffolding", () => {
  it("keeps exactly one generated REST client", () => {
    // src/selfhost.ts is generated from the live OpenAPI doc by
    // scripts/generate-selfhost-sdk.ts and drift-checked in CI. sdk/ was a second,
    // hand-maintained client that nothing built, published, or regenerated — yet
    // root `bun test` collected its tests and reported it green.
    expect(existsSync(join(root, "src/selfhost.ts"))).toBe(true);
    expect(existsSync(join(root, "sdk"))).toBe(false);
  });

  it("has no unreferenced operator or build scripts", () => {
    expect(existsSync(join(root, "scripts/nightly_sync.sh"))).toBe(false);
    expect(existsSync(join(root, "scripts/docker-prune-file-deps.mjs"))).toBe(false);
  });

  it("has no duplicate storage-mode resolver", () => {
    // src/lib/mode.ts + src/server/self-hosted/env.ts are the live resolvers.
    expect(existsSync(join(root, "src/storage-kit/mode.ts"))).toBe(false);
  });
});
