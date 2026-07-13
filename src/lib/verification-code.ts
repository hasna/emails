import { type InboundEmail } from "../db/inbound.js";

export interface VerificationCodeEmail {
  id: string;
  from_address: string;
  subject: string;
  text_body: string | null;
  html_body: string | null;
  received_at: string;
}

export interface VerificationCodeCandidateOptions {
  limit?: number;
  since?: string;
  from?: string;
  subject?: string;
}

export interface VerificationCodeMatch<T extends VerificationCodeEmail = InboundEmail> {
  code: string;
  email: T;
  confidence: "high" | "medium";
}

const CODE_CONTEXT_RE = /(?:code|verification|verify|temporary|one[-\s]?time|otp|passcode)[^\d]{0,80}(\d[\d\s-]{3,12}\d)/gi;
const STANDALONE_CODE_RE = /(?<!\d)(\d{4,10})(?!\d)/g;

function normalizeCode(raw: string): string {
  return raw.replace(/[^\d]/g, "");
}

export function extractVerificationCodes(text: string): string[] {
  const ordered = new Map<string, number>();
  for (const match of text.matchAll(CODE_CONTEXT_RE)) {
    const code = normalizeCode(match[1] ?? "");
    if (code.length >= 4 && code.length <= 10) ordered.set(code, (ordered.get(code) ?? 0) + 2);
  }
  for (const match of text.matchAll(STANDALONE_CODE_RE)) {
    const code = normalizeCode(match[1] ?? "");
    if (code.length >= 4 && code.length <= 10) ordered.set(code, (ordered.get(code) ?? 0) + (code.length === 6 ? 1 : 0));
  }
  return [...ordered.entries()]
    .sort((a, b) => b[1] - a[1] || (b[0].length === 6 ? 1 : 0) - (a[0].length === 6 ? 1 : 0))
    .map(([code]) => code);
}

// Verification-code candidates come from the inbound message store, which is a
// server-side `/v1` resource in the self-hosted client. The routed candidate read
// lives on the async data-source seam — `resolveMailDataSource().verificationCandidates(address, opts)`
// (implemented by SelfHostedMailDataSource over `/v1`) — which callers use
// directly. This synchronous SQLite helper has no local store to read, so it
// fails loud rather than returning an empty list. `findVerificationCode` (below)
// remains a pure matcher over whatever candidates the seam returns.
export function listVerificationCodeCandidates(
  _address: string,
  _opts: VerificationCodeCandidateOptions = {},
): VerificationCodeEmail[] {
  throw new Error(
    "listVerificationCodeCandidates is not available in the self-hosted client; use resolveMailDataSource().verificationCandidates(...), which reads inbound messages over /v1.",
  );
}

export function findVerificationCode<T extends VerificationCodeEmail = InboundEmail>(
  emails: T[],
  filters: { from?: string; subject?: string } = {},
): VerificationCodeMatch<T> | null {
  const from = filters.from?.toLowerCase();
  const subject = filters.subject?.toLowerCase();
  const sorted = [...emails].sort((a, b) => Date.parse(b.received_at) - Date.parse(a.received_at));

  for (const email of sorted) {
    if (from && !email.from_address.toLowerCase().includes(from)) continue;
    if (subject && !email.subject.toLowerCase().includes(subject)) continue;
    const body = [email.subject, email.text_body ?? "", email.html_body ?? ""].join("\n");
    const [code] = extractVerificationCodes(body);
    if (!code) continue;
    const high = /code|verification|verify|temporary|otp|passcode/i.test(body);
    return { code, email, confidence: high ? "high" : "medium" };
  }

  return null;
}
