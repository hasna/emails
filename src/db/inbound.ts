import * as local from "./inbound.local.js";
import * as remote from "./inbound.remote.js";
import { isSelfHostedMode } from "./self-hosted-store.js";
import { hasDatabaseArgument, withExplicitDatabaseRoute } from "./database-routing.js";

export type * from "./inbound.local.js";

const localCompat = {
  ...local,
  listReplies: (emailId, opts) => local.listReplies(emailId, undefined, opts),
  listReplySummaries: (emailId, opts) => local.listReplySummaries(emailId, undefined, opts),
  listReplyPromptParts: (emailId, opts) => local.listReplyPromptParts(emailId, undefined, opts),
} as typeof remote;

type RoutedFunction<K extends keyof typeof remote & keyof typeof local> = typeof local[K] & typeof remote[K];

function routed<K extends keyof typeof remote & keyof typeof local>(key: K): RoutedFunction<K> {
  return ((...args: unknown[]) => {
    const implementation = (hasDatabaseArgument(args) ? local : isSelfHostedMode() ? remote : localCompat) as Record<string, unknown>;
    const candidate = implementation[String(key)];
    if (typeof candidate !== "function") throw new Error(`inbound.${String(key)} is unavailable in the selected mode.`);
    return withExplicitDatabaseRoute(args, () => (candidate as (...values: unknown[]) => unknown)(...args));
  }) as RoutedFunction<K>;
}

export const normalizeEmailAddress = routed("normalizeEmailAddress");
export const inboundRecipientMatches = routed("inboundRecipientMatches");
export const storeInboundEmail = routed("storeInboundEmail");
export const updateAttachmentPaths = routed("updateAttachmentPaths");
export const listReplies = routed("listReplies");
export const listReplySummaries = routed("listReplySummaries");
export const listReplyPromptParts = routed("listReplyPromptParts");
export const getReplyCount = routed("getReplyCount");
export const getInboundEmail = routed("getInboundEmail");
export const getInboundEmailSummary = routed("getInboundEmailSummary");
export const getInboundAttachmentPaths = routed("getInboundAttachmentPaths");
export const listInboundSubjectsForRecipient = routed("listInboundSubjectsForRecipient");
export const listInboundEmails = routed("listInboundEmails");
export const listInboundEmailSummaries = routed("listInboundEmailSummaries");
export const listInboundEmailsForOwner = routed("listInboundEmailsForOwner");
export const listInboundEmailSummariesForOwner = routed("listInboundEmailSummariesForOwner");
export const inboundEmailBelongsToOwner = routed("inboundEmailBelongsToOwner");
export const deleteInboundEmail = routed("deleteInboundEmail");
export const clearInboundEmails = routed("clearInboundEmails");
export const getInboundCount = routed("getInboundCount");
export const getReceivedInboundCount = routed("getReceivedInboundCount");
export const getLatestInboundReceivedAt = routed("getLatestInboundReceivedAt");
export const getLatestReceivedInboundAt = routed("getLatestReceivedInboundAt");
export const setInboundRead = routed("setInboundRead");
export const setInboundReadSummary = routed("setInboundReadSummary");
export const setInboundReadFlag = routed("setInboundReadFlag");
export const setInboundArchived = routed("setInboundArchived");
export const setInboundArchivedSummary = routed("setInboundArchivedSummary");
export const setInboundArchivedFlag = routed("setInboundArchivedFlag");
export const setInboundStarred = routed("setInboundStarred");
export const setInboundStarredSummary = routed("setInboundStarredSummary");
export const setInboundStarredFlag = routed("setInboundStarredFlag");
export const addInboundLabel = routed("addInboundLabel");
export const addInboundLabelSummary = routed("addInboundLabelSummary");
export const removeInboundLabel = routed("removeInboundLabel");
export const removeInboundLabelSummary = routed("removeInboundLabelSummary");
export const getUnreadCount = routed("getUnreadCount");
