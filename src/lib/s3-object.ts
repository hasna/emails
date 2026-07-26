export interface ParsedS3ObjectUrl {
  bucket: string;
  key: string;
}

export function s3ObjectUrl(bucket: string, key: string): string {
  return `s3://${bucket}/${key}`;
}

export function parseS3ObjectUrl(url: string): ParsedS3ObjectUrl {
  const trimmed = url.trim();
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(trimmed);
  if (!match) throw new Error(`Invalid S3 object URL: ${url}`);
  return { bucket: match[1]!, key: match[2]! };
}
