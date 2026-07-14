import * as local from "./send.local.js";
import * as remote from "./send.remote.js";
import { isSelfHostedMode } from "../db/self-hosted-store.js";

export type * from "./send.local.js";

function routed<K extends keyof typeof local>(key: K): typeof local[K] {
  return ((...args: unknown[]) => {
    const implementation = (isSelfHostedMode() ? remote : local) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`send.${String(key)} is unavailable in the selected mode.`);
    return (candidate as (...values: unknown[]) => unknown)(...args);
  }) as typeof local[K];
}

export const getAttachmentDecodedSize = routed("getAttachmentDecodedSize");
export const validateSendAttachments = routed("validateSendAttachments");
export const assertWarmingLimit = routed("assertWarmingLimit");
export const assertDomainOutboundReady = routed("assertDomainOutboundReady");
export const sendWithFailover = routed("sendWithFailover");
export const MAX_ATTACHMENT_SIZE_BYTES = local.MAX_ATTACHMENT_SIZE_BYTES;
export const MAX_ATTACHMENT_COUNT = local.MAX_ATTACHMENT_COUNT;
