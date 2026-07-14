// Pure, storage-independent runtime helpers shared by local and self-hosted
// resource repositories.

export function now(): string {
  return new Date().toISOString();
}

export function uuid(): string {
  return crypto.randomUUID();
}
