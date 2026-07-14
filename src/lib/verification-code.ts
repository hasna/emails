import * as local from "./verification-code.local.js";
import * as remote from "./verification-code.remote.js";
import { isSelfHostedMode } from "../db/self-hosted-store.js";

export type * from "./verification-code.local.js";

function routed<K extends keyof typeof local>(key: K): typeof local[K] {
  return ((...args: unknown[]) => {
    const implementation = (isSelfHostedMode() ? remote : local) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`verification-code.${String(key)} is unavailable in the selected mode.`);
    return (candidate as (...values: unknown[]) => unknown)(...args);
  }) as typeof local[K];
}

export const extractVerificationCodes = routed("extractVerificationCodes");
export const listVerificationCodeCandidates = routed("listVerificationCodeCandidates");
export const findVerificationCode = routed("findVerificationCode");
