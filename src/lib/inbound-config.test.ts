import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { getInboundConfig, setConfigValue } from "./config.js";

let INHERITED_PROCESS_ENV: NodeJS.ProcessEnv;
let origHome: string | undefined;
function captureInheritedProcessEnv(): void {
  INHERITED_PROCESS_ENV = { ...process.env };
  origHome = process.env.HOME;
}
function restoreInheritedProcessEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
}

const TMP_HOME = join("/tmp", `emails-inbound-cfg-test-${process.pid}`);

beforeEach(() => {
  captureInheritedProcessEnv();
  mkdirSync(TMP_HOME, { recursive: true });
  process.env.HOME = TMP_HOME;
});
afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (existsSync(TMP_HOME)) rmSync(TMP_HOME, { recursive: true, force: true });
  delete process.env["EMAILS_INBOUND_S3_BUCKET"];
  restoreInheritedProcessEnv();
});

describe("getInboundConfig", () => {
  it("defaults region to us-east-1", () => {
    const origRegion = process.env["AWS_REGION"]; delete process.env["AWS_REGION"];
    expect(getInboundConfig().region).toBe("us-east-1");
    if (origRegion === undefined) delete process.env["AWS_REGION"];
    else process.env["AWS_REGION"] = origRegion;
  });
  it("reads bucket from env when no config value", () => {
    process.env["EMAILS_INBOUND_S3_BUCKET"] = "b1";
    expect(getInboundConfig().bucket).toBe("b1");
  });
  it("config value takes precedence over env", () => {
    process.env["EMAILS_INBOUND_S3_BUCKET"] = "env-bucket";
    setConfigValue("inbound_s3_bucket", "cfg-bucket");
    expect(getInboundConfig().bucket).toBe("cfg-bucket");
  });
});
