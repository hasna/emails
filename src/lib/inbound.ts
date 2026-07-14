import * as local from "./inbound.local.js";
import * as remote from "./inbound.remote.js";
import { getEmailsMode } from "./mode.js";

export type * from "./inbound.local.js";

function routed<K extends keyof typeof local>(key: K): typeof local[K] {
  return ((...args: unknown[]) => {
    const implementation = (getEmailsMode() === "self_hosted" ? remote : local) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`inbound.${String(key)} is unavailable in the selected mode.`);
    return candidate(...args);
  }) as typeof local[K];
}

export const parseMimeEmail = routed("parseMimeEmail");
export const parseResendInbound = routed("parseResendInbound");
export const parseMailgunInbound = routed("parseMailgunInbound");
export const createSmtpServer = routed("createSmtpServer");
