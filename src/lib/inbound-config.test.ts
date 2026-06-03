import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { getInboundConfig, setConfigValue } from "./config.js";

const TMP_HOME = join("/tmp", `emails-inbound-cfg-test-${process.pid}`);
const origHome = process.env.HOME;

beforeEach(() => { mkdirSync(TMP_HOME, { recursive: true }); process.env.HOME = TMP_HOME; });
afterEach(() => {
  process.env.HOME = origHome;
  if (existsSync(TMP_HOME)) rmSync(TMP_HOME, { recursive: true, force: true });
  delete process.env["EMAILS_INBOUND_S3_BUCKET"];
});

describe("getInboundConfig", () => {
  it("defaults region to us-east-1", () => {
    const origRegion = process.env["AWS_REGION"]; delete process.env["AWS_REGION"];
    expect(getInboundConfig().region).toBe("us-east-1");
    if (origRegion) process.env["AWS_REGION"] = origRegion;
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
