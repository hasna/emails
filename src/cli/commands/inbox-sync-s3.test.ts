import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("inbox sync-s3 configuration hint", () => {
  it("points a missing bucket at configuration mechanisms that exist", async () => {
    const tempHome = mkdtempSync(join(tmpdir(), "emails-inbox-sync-s3-home-"));
    const env = {
      ...process.env,
      HOME: tempHome,
      EMAILS_MODE: "local",
      EMAILS_DB_PATH: ":memory:",
      NO_COLOR: "1",
    };
    delete env.EMAILS_INBOUND_S3_BUCKET;

    try {
      const child = Bun.spawn({
        cmd: [process.execPath, "run", "src/cli/index.tsx", "inbox", "sync-s3"],
        cwd: process.cwd(),
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);

      expect(exitCode).toBe(1);
      expect(stderr).toContain("EMAILS_INBOUND_S3_BUCKET");
      expect(stderr).toContain("~/.hasna/emails/config.json");
      expect(stderr).not.toContain("emails config set");
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
