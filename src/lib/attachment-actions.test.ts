import { describe, expect, it } from "bun:test";
import { formatAttachmentSize, mergeAttachmentDetails } from "./attachment-actions.js";

describe("attachment action helpers", () => {
  it("formats stable human-readable sizes", () => {
    expect(formatAttachmentSize(512)).toBe("512 B");
    expect(formatAttachmentSize(2048)).toBe("2 KB");
    expect(formatAttachmentSize(2.5 * 1024 * 1024)).toBe("2.5 MB");
  });

  it("merges metadata with local and S3 locations", () => {
    const attachments = mergeAttachmentDetails(
      [
        { filename: "invoice.pdf", content_type: "application/pdf", size: 2048 },
        { filename: "remote.csv", content_type: "text/csv", size: 100 },
      ],
      [
        { filename: "invoice.pdf", local_path: "/tmp/invoice.pdf" },
        { filename: "remote.csv", s3_url: "s3://bucket/remote.csv" },
      ],
    );

    expect(attachments[0]).toMatchObject({
      filename: "invoice.pdf",
      location: "/tmp/invoice.pdf",
      location_type: "local",
      file_url: "file:///tmp/invoice.pdf",
      openable: true,
    });
    expect(attachments[1]).toMatchObject({
      filename: "remote.csv",
      location: "s3://bucket/remote.csv",
      location_type: "s3",
      openable: false,
    });
  });
});
