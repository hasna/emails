import { localFileUrl } from "./local-actions.js";

export interface AttachmentMetaLike {
  filename: string;
  content_type?: string;
  size?: number;
}

export interface AttachmentPathLike {
  filename: string;
  content_type?: string;
  local_path?: string;
  s3_url?: string;
}

export interface AttachmentDetail {
  filename: string;
  content_type: string;
  size: number;
  location?: string;
  location_type?: "local" | "s3";
  file_url?: string;
  openable: boolean;
}

export function formatAttachmentSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  if (size < 1024) return `${Math.round(size)} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

export function mergeAttachmentDetails(
  meta: readonly AttachmentMetaLike[] = [],
  paths: readonly AttachmentPathLike[] = [],
): AttachmentDetail[] {
  const byName = new Map<string, AttachmentDetail>();
  for (const attachment of meta) {
    if (!attachment.filename) continue;
    byName.set(attachment.filename, {
      filename: attachment.filename,
      content_type: attachment.content_type ?? "application/octet-stream",
      size: Number.isFinite(attachment.size) ? Number(attachment.size) : 0,
      openable: false,
    });
  }

  for (const path of paths) {
    if (!path.filename) continue;
    const current = byName.get(path.filename) ?? {
      filename: path.filename,
      content_type: path.content_type ?? "application/octet-stream",
      size: 0,
      openable: false,
    };
    if (path.local_path) {
      current.location = path.local_path;
      current.location_type = "local";
      current.file_url = localFileUrl(path.local_path);
      current.openable = true;
    } else if (path.s3_url) {
      current.location = path.s3_url;
      current.location_type = "s3";
      current.openable = false;
    }
    if (!current.content_type && path.content_type) current.content_type = path.content_type;
    byName.set(path.filename, current);
  }

  return [...byName.values()];
}
