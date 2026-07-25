import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import contract from "../hasna.contract.json" with { type: "json" };
import { EMAILS_MODE_ENV_KEYS, resolveEmailsModeSelection } from "./lib/mode.js";
import { SELF_HOSTED_APP, SELF_HOSTED_APP_ALIASES } from "./server/self-hosted/env.js";

const root = join(import.meta.dir, "..");

// Canonical published identity.
//
// npm serves TWO distinct lines under the Hasna scope:
//   @hasna/emails  — this package (latest 1.2.6), the line production deploys
//                    as the `emails` bin at v1.2.7.
//   @hasna/mailery — the ABANDONED 0.6.x line (last publish 0.6.116).
//
// CHANGELOG [0.6.117] already renamed this package back to @hasna/emails and
// freed the mailery/mailery-mcp/mailery-serve bins for the separate cloud CLI
// (@hasnatools/mailery). Publishing this tree as @hasna/mailery would resurrect
// the abandoned name, strand @hasna/emails at 1.2.6 for every existing install,
// and collide with the cloud CLI's bins. These assertions pin the decision.
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
