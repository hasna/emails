import { describe, expect, it } from "bun:test";
import { describeLocalOpenTarget, localFileUrl, normalizeWebUrl, openLocalTarget, type LocalActionRuntime } from "./local-actions.js";

function runtime(files = new Set<string>(), platform: NodeJS.Platform = "linux") {
  const calls: string[][] = [];
  const fake: LocalActionRuntime = {
    platform,
    fileExists: (path) => files.has(path),
    spawnSync: (cmd) => {
      calls.push(cmd);
      return { exitCode: 0 };
    },
  };
  return { fake, calls };
}

describe("local action helpers", () => {
  it("normalizes only openable web URLs", () => {
    expect(normalizeWebUrl("www.EXAMPLE.com/path")).toBe("https://www.example.com/path");
    expect(normalizeWebUrl("https://Example.com/a")).toBe("https://example.com/a");
    expect(normalizeWebUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeWebUrl("file:///tmp/test.txt")).toBeNull();
  });

  it("describes existing local files as file URLs", () => {
    const { fake } = runtime(new Set(["/tmp/report.pdf"]));
    const target = describeLocalOpenTarget("/tmp/report.pdf", fake);

    expect(target).toMatchObject({
      kind: "file",
      value: "/tmp/report.pdf",
      file_url: "file:///tmp/report.pdf",
    });
    expect(localFileUrl("/tmp/report.pdf")).toBe("file:///tmp/report.pdf");
  });

  it("opens URLs and files without using a shell command string", () => {
    const { fake, calls } = runtime(new Set(["/tmp/report.pdf"]));

    expect(openLocalTarget("https://example.com", fake)).toMatchObject({ ok: true, method: "xdg-open" });
    expect(openLocalTarget("/tmp/report.pdf", fake)).toMatchObject({ ok: true, method: "xdg-open" });
    expect(calls).toEqual([
      ["xdg-open", "https://example.com/"],
      ["xdg-open", "/tmp/report.pdf"],
    ]);
  });

  it("rejects unsupported targets", () => {
    const { fake } = runtime();

    expect(openLocalTarget("s3://bucket/file.pdf", fake).ok).toBe(false);
    expect(openLocalTarget("/tmp/missing.pdf", fake).ok).toBe(false);
  });
});
