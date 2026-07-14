import * as local from "./delivery-doctor.local.js";
import * as remote from "./delivery-doctor.remote.js";
import { getEmailsMode } from "./mode.js";

export type * from "./delivery-doctor.local.js";

function routed<K extends keyof typeof local>(key: K): typeof local[K] {
  return ((...args: unknown[]) => {
    const implementation = (getEmailsMode() === "self_hosted" ? remote : local) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`delivery-doctor.${String(key)} is unavailable in the selected mode.`);
    return candidate(...args);
  }) as typeof local[K];
}

export const diagnoseInboundDelivery = routed("diagnoseInboundDelivery");
export const diagnoseInboundDeliveryLive = routed("diagnoseInboundDeliveryLive");
export const formatDeliveryDoctorReport = routed("formatDeliveryDoctorReport");
