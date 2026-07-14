import * as local from "./sync.local.js";
import * as remote from "./sync.remote.js";
import { getEmailsMode } from "./mode.js";

export const syncProvider: typeof local.syncProvider = (providerId, db, adapterOverride) =>
  getEmailsMode() === "self_hosted"
    ? remote.syncProvider(providerId, adapterOverride)
    : local.syncProvider(providerId, db, adapterOverride);

export const syncAll: typeof local.syncAll = (db) =>
  getEmailsMode() === "self_hosted" ? remote.syncAll() : local.syncAll(db);
