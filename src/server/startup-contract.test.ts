import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { routeModulesFor } from "./api-routes.js";

const routesDir = join(import.meta.dir, "routes");
const apiRoutesFile = join(import.meta.dir, "api-routes.ts");
const serverIndexFile = join(import.meta.dir, "index.ts");

const heavyRouteImports = [
  "@aws-sdk/",
  "@hasna/connectors",
  "mailparser",
  "../../lib/send.js",
  "../../lib/sync.js",
  "../../lib/doctor.js",
  "../../lib/delivery-doctor.js",
  "../../lib/agent-context.js",
  "../../lib/s3-sync.js",
  "../../lib/aws-inbound.js",
  "../../lib/batch.js",
];

const staticImport = /^\s*import\s+(?!type\b)[\s\S]*?\sfrom\s+["']([^"']+)["'];/gm;

function routeFiles(): string[] {
  return readdirSync(routesDir)
    .filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\.(ts|tsx)$/.test(file))
    .map((file) => join(routesDir, file));
}

describe("server startup contract", () => {
  it("keeps direct help and version available without booting the HTTP runtime", () => {
    for (const args of [["--help"], ["--version"]]) {
      const result = Bun.spawnSync({
        cmd: ["bun", "src/server/index.ts", ...args],
        cwd: join(import.meta.dir, "..", ".."),
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = new TextDecoder().decode(result.stderr);
      expect(result.exitCode).toBe(0);
      expect(stderr).toBe("");
    }
  });

  it("fails closed on legacy hosted mode variables instead of booting local", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "src/server/index.ts"],
      cwd: join(import.meta.dir, "..", ".."),
      env: { ...process.env, MAILERY_MODE: "cloud", PORT: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const combined = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode).not.toBe(0);
    expect(combined).toContain("MAILERY_MODE");
    expect(combined).toContain("removed hosted/legacy runtime");
  });

  it("selects the operator service without requiring self-hosted client credentials", () => {
    const source = readFileSync(serverIndexFile, "utf8");
    expect(source).toContain("resolveEmailsModeSelection");
    expect(source).not.toMatch(/const mode = resolveEmailsMode\(\)\.mode/);
  });

  for (const command of ["ingest-worker", "ingest-s3-backfill"] as const) {
    it(`${command} reaches operator validation without a client URL or API/session key`, () => {
      const env = { ...process.env };
      for (const key of ["EMAILS_SELF_HOSTED_URL", "EMAILS_SELF_HOSTED_API_KEY", "EMAILS_SESSION_TOKEN"]) {
        delete env[key];
      }
      Object.assign(env, {
        EMAILS_MODE: "self_hosted",
        EMAILS_DATABASE_URL: "postgres://operator.invalid/emails",
      });
      if (command === "ingest-worker") {
        env["EMAILS_INGEST_QUEUE_URL"] = "https://sqs.invalid/operator-queue";
      }

      const result = Bun.spawnSync({
        cmd: ["bun", "src/server/index.ts", command],
        cwd: join(import.meta.dir, "..", ".."),
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const combined = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
      expect(result.exitCode).not.toBe(0);
      expect(combined).toContain("EMAILS_INGEST_S3_BUCKET");
      expect(combined).not.toContain("EMAILS_SELF_HOSTED_URL");
      expect(combined).not.toContain("EMAILS_SELF_HOSTED_API_KEY");
    });
  }

  it("keeps route modules lazy behind the API dispatcher", () => {
    const source = readFileSync(apiRoutesFile, "utf8");
    const staticRouteImports = [...source.matchAll(staticImport)]
      .map((match) => match[1] ?? "")
      .filter((specifier) => specifier.startsWith("./routes/"));

    expect(staticRouteImports).toEqual([]);
    expect(source).toContain("routeModulesFor");
    expect(source).toContain('import("./routes/core.js")');
    expect(source).toContain('import("./routes/contacts-groups.js")');
    expect(source).toContain('import("./routes/inbound-sequences.js")');
  });

  it("routes common server paths to the smallest route module set", () => {
    expect(routeModulesFor("/webhook/ses-inbound")).toEqual(["inbound-webhook"]);
    expect(routeModulesFor("/webhook/resend-inbound")).toEqual(["resend-webhook"]);
    expect(routeModulesFor("/api/providers")).toEqual(["core"]);
    expect(routeModulesFor("/api/providers/abc/auth")).toEqual(["core"]);
    expect(routeModulesFor("/api/templates/welcome")).toEqual(["contacts-groups"]);
    expect(routeModulesFor("/api/digest")).toEqual(["inbound-sequences"]);
    expect(routeModulesFor("/api/sequences/abc/enrollments")).toEqual(["inbound-sequences"]);
    expect(routeModulesFor("/track/open/email-1")).toEqual(["inbound-sequences"]);
    expect(routeModulesFor("/api/unknown")).toEqual([
      "inbound-webhook",
      "resend-webhook",
      "core",
      "contacts-groups",
      "inbound-sequences",
    ]);
  });

  it("keeps heavy route dependencies behind route-local dynamic imports", () => {
    const offenders: string[] = [];

    for (const file of routeFiles()) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(staticImport)) {
        const specifier = match[1] ?? "";
        if (heavyRouteImports.some((heavy) => specifier === heavy || specifier.startsWith(heavy))) {
          offenders.push(`${file.replace(`${routesDir}/`, "")}: ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
