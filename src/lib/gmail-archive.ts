import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export interface GmailArchiveKeyInput {
  profile: string;
  messageId: string;
  prefix?: string;
}

export interface GmailArchiveKeys {
  raw: string;
  metadata: string;
}

export interface GmailArchiveUploadInput extends GmailArchiveKeyInput {
  bucket: string;
  region?: string;
  raw?: string;
  metadata: unknown;
}

export interface GmailArchiveUploadResult {
  raw_s3_url?: string;
  metadata_s3_url: string;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._=-]+/g, "_");
}

export function buildGmailArchiveKeys(input: GmailArchiveKeyInput): GmailArchiveKeys {
  const prefix = (input.prefix ?? "gmail").replace(/^\/+|\/+$/g, "");
  const profile = safeSegment(input.profile || "default");
  const messageId = safeSegment(input.messageId);
  return {
    raw: `${prefix}/${profile}/raw/${messageId}.eml`,
    metadata: `${prefix}/${profile}/metadata/${messageId}.json`,
  };
}

export async function uploadGmailArchive(input: GmailArchiveUploadInput): Promise<GmailArchiveUploadResult> {
  const client = new S3Client({ region: input.region ?? "us-east-1" });
  const keys = buildGmailArchiveKeys(input);

  const metadataBody = JSON.stringify(input.metadata, null, 2);
  await client.send(new PutObjectCommand({
    Bucket: input.bucket,
    Key: keys.metadata,
    Body: metadataBody,
    ContentType: "application/json",
  }));

  const result: GmailArchiveUploadResult = {
    metadata_s3_url: `s3://${input.bucket}/${keys.metadata}`,
  };

  if (input.raw) {
    await client.send(new PutObjectCommand({
      Bucket: input.bucket,
      Key: keys.raw,
      Body: Buffer.from(input.raw, "base64url"),
      ContentType: "message/rfc822",
    }));
    result.raw_s3_url = `s3://${input.bucket}/${keys.raw}`;
  }

  return result;
}
