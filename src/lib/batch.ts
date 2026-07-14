import * as local from "./batch.local.js";
import * as remote from "./batch.remote.js";
import { getEmailsMode } from "./mode.js";

export { parseCsv } from "./csv.js";
export type * from "./batch.local.js";

export const batchSend: typeof local.batchSend = (...args) =>
  (getEmailsMode() === "self_hosted" ? remote.batchSend : local.batchSend)(...args);
