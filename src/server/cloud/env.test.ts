import { describe, expect, test } from "bun:test";
import { isCloudMode, normalizeCloudEnv } from "./env.js";

describe("self_hosted server env", () => {
  test("DATABASE_URL defaults shared deployments to self_hosted", () => {
    const env = { DATABASE_URL: "postgres://user:pass@example/db" } as NodeJS.ProcessEnv;

    normalizeCloudEnv(env);

    expect(env.HASNA_MAILERY_STORAGE_MODE).toBe("self_hosted");
    expect(isCloudMode(env)).toBe(true);
  });

  test("explicit self_hosted without a database URL fails closed", () => {
    const env = { HASNA_MAILERY_STORAGE_MODE: "self_hosted" } as NodeJS.ProcessEnv;

    expect(() => isCloudMode(env)).toThrow(/requires HASNA_MAILERY_DATABASE_URL/);
  });

  test("removed cloud and hybrid modes are rejected", () => {
    for (const value of ["cloud", "remote", "hybrid"]) {
      const env = {
        HASNA_MAILERY_STORAGE_MODE: value,
        HASNA_MAILERY_DATABASE_URL: "postgres://user:pass@example/db",
      } as NodeJS.ProcessEnv;
      expect(() => isCloudMode(env)).toThrow(/removed from Hasna OSS/);
    }
  });
});
