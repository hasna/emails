import * as local from "./data.local.js";
import * as remote from "./data.remote.js";
import { isSelfHostedMode } from "../../db/self-hosted-store.js";

export * from "../../lib/mail-types.js";
export type {
  DomainSummary,
  ListDomainSummaryOptions,
  InboxAddressChoice,
  ListInboxAddressOptions,
  InboxSource,
  TuiSettings,
} from "./data.local.js";
export type { TenantContext } from "./data.remote.js";
export const ALL_ADDRESSES = local.ALL_ADDRESSES;

const localCompat = {
  ...local,
  getConversationBodies: (message: Parameters<typeof remote.getConversationBodies>[0], options?: Parameters<typeof remote.getConversationBodies>[1]) => local.getConversationBodies(message, undefined, options),
} as typeof remote;

function routed<K extends keyof typeof remote>(key: K): typeof remote[K] {
  return ((...args: unknown[]) => {
    const implementation = (isSelfHostedMode() ? remote : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`tui.data.${String(key)} is unavailable in the selected mode.`);
    return (candidate as (...values: unknown[]) => unknown)(...args);
  }) as typeof remote[K];
}

export const mailboxSourceFromRef = routed("mailboxSourceFromRef");
export const listMailbox = routed("listMailbox");
export const mailboxCounts = routed("mailboxCounts");
export const listMailboxStatus = routed("listMailboxStatus");
export const searchMailbox = routed("searchMailbox");
export const listMailboxSources = routed("listMailboxSources");
export const getMessageBody = routed("getMessageBody");
export const getConversation = routed("getConversation");
export const getConversationBodies = routed("getConversationBodies");
export const toggleStar = routed("toggleStar");
export const toggleRead = routed("toggleRead");
export const markRead = routed("markRead");
export const archiveMessage = routed("archiveMessage");
export const listLabelSummaries = routed("listLabelSummaries");
export const toggleMessageLabel = routed("toggleMessageLabel");
export const activeProviderId = routed("activeProviderId");
export const providerIdForSender = routed("providerIdForSender");
export const defaultFromAddress = routed("defaultFromAddress");
export const sendComposed = routed("sendComposed");
export const listDomainSummaries = routed("listDomainSummaries");
export const listInboxAddresses = routed("listInboxAddresses");
export const addressChoiceByAddress = routed("addressChoiceByAddress");
export const listSources = routed("listSources");
export const getSettings = routed("getSettings");
export const setSetting = routed("setSetting");

export const getTenantContext: typeof remote.getTenantContext = (force = false) =>
  isSelfHostedMode() ? remote.getTenantContext(force) : { identity: null, label: "Local" };

export const resetTenantContextCache: typeof remote.resetTenantContextCache = () => {
  if (isSelfHostedMode()) remote.resetTenantContextCache();
};
