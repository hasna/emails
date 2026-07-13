import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  syncS3Inbox,
  registerS3Source,
  retireS3Source,
  listS3Sources,
  listLiveS3Sources,
} from "./s3-sync.js";

// S3 → mailbox ingestion (syncS3Inbox) runs on the self-hosted server: the thin
// client has no local inbound store to write into, so it is a loud stub. The S3
// *source registry* (register/list/retire) is pure client config backed by the
// local config file with no database dependency, so it remains functional and is
// covered here.

const originalHome = process.env["HOME"];
let tmpHome = "";

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "emails-s3-source-"));
  process.env["HOME"] = tmpHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
});

describe("syncS3Inbox (self-hosted stub)", () => {
  it("throws because S3 inbound ingestion runs on the self-hosted server", async () => {
    await expect(syncS3Inbox({ bucket: "test-bucket", providerId: "p1" })).rejects.toThrow(
      /syncS3Inbox is not available in the self-hosted client/,
    );
  });

  it("throws for a source-id driven sync too", async () => {
    await expect(syncS3Inbox({ sourceId: "s3-anything" })).rejects.toThrow(
      /S3 inbound ingestion runs on the self-hosted server/,
    );
  });
});

describe("S3 source registry (client config)", () => {
  it("registers a source and lists it back", () => {
    const source = registerS3Source({
      bucket: "inbound-bucket",
      prefix: "inbound/example.com/",
      region: "eu-west-1",
      providerId: "prov-1",
      status: "live",
      liveSyncEnabled: true,
    });

    expect(source).toMatchObject({
      type: "s3",
      bucket: "inbound-bucket",
      prefix: "inbound/example.com/",
      region: "eu-west-1",
      provider_id: "prov-1",
      status: "live",
      live_sync_enabled: true,
    });

    const listed = listS3Sources();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ bucket: "inbound-bucket", status: "live" });
  });

  it("dedupes by bucket + prefix and preserves created_at on update", () => {
    const first = registerS3Source({ bucket: "b", prefix: "inbound/", providerId: "p1", status: "live" });
    const second = registerS3Source({ bucket: "b", prefix: "inbound/", providerId: "p2", status: "live" });

    const listed = listS3Sources();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.provider_id).toBe("p2");
    expect(second.created_at).toBe(first.created_at);
  });

  it("only surfaces live sources from listLiveS3Sources", () => {
    registerS3Source({ id: "s3-live", bucket: "live-bucket", prefix: "a/", providerId: "p1", status: "live", liveSyncEnabled: true });
    registerS3Source({ id: "s3-legacy", bucket: "legacy-bucket", prefix: "b/", providerId: "p1", status: "legacy" });

    const live = listLiveS3Sources();
    expect(live.map((s) => s.id)).toEqual(["s3-live"]);
  });

  it("retires a source so it drops out of the live set", () => {
    const source = registerS3Source({ id: "s3-retire", bucket: "retire-bucket", prefix: "inbound/", providerId: "p1", status: "live", liveSyncEnabled: true });
    expect(listLiveS3Sources().map((s) => s.id)).toEqual(["s3-retire"]);

    const retired = retireS3Source(source.id);
    expect(retired.status).toBe("retired");
    expect(retired.live_sync_enabled).toBe(false);
    expect(listLiveS3Sources()).toHaveLength(0);
    expect(listS3Sources().map((s) => s.status)).toEqual(["retired"]);
  });

  it("throws when retiring an unknown source", () => {
    expect(() => retireS3Source("does-not-exist")).toThrow(/S3 source not found/);
  });
});
