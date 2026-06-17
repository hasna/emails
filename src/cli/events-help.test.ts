import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runHelp() {
  const eventsDir = mkdtempSync(join(tmpdir(), "emails-events-"));
  try {
    return Bun.spawnSync({
      cmd: ["bun", "run", "src/cli/index.tsx", "--help"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HASNA_EVENTS_DIR: eventsDir },
    });
  } finally {
    rmSync(eventsDir, { recursive: true, force: true });
  }
}

function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf-8");
}

describe("emails events CLI", () => {
  test("help exposes shared events and webhooks commands", () => {
    const result = runHelp();
    const stdout = text(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("events");
    expect(stdout).toContain("webhooks");
  });
});
