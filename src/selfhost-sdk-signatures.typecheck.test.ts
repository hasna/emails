import type {
  AttachmentBatchMeta,
  AttachmentMeta,
  EmailsSelfHostClient,
  Message,
  SendKey,
  Tenant,
} from "./selfhost.js";

type Equal<Left, Right> =
  (<Type>() => Type extends Left ? 1 : 2) extends
  (<Type>() => Type extends Right ? 1 : 2)
    ? true
    : false;
type Assert<Value extends true> = Value;
type Result<Method extends keyof EmailsSelfHostClient> =
  EmailsSelfHostClient[Method] extends (...args: never[]) => infer Return
    ? Awaited<Return>
    : never;

type BootstrapResult = Result<"bootstrapPrimarySuperAdmin">;
type PrincipalResult = Result<"getCurrentPrincipal">;
type UserPrincipal = Extract<PrincipalResult, { principal_type: "user" }>;
type VerifiedEmailResult = Result<"verifyEmailToken">;
type VerifySendKeyResult = Result<"verifySendKey">;
type SendResult = Result<"sendMessage">;
type BatchAttachmentsResult = Result<"batchAttachments">;

export type NullableTenantRegression =
  Assert<Equal<BootstrapResult["tenant"], Tenant | null>>;
export type NullableUserRegression =
  Assert<Equal<UserPrincipal["user"], VerifiedEmailResult["user"] | null>>;
export type NullableKeyRegression =
  Assert<Equal<VerifySendKeyResult["key"], SendKey | null>>;
export type ReplaySendRegression =
  Assert<Equal<
    Extract<SendResult, { idempotent_replay: true }>["provider_message_id"],
    string
  >>;
export type InProgressSendRegression =
  Assert<Equal<Extract<SendResult, { in_progress: true }>["in_progress"], true>>;
export type AcceptedSendRegression =
  Assert<Equal<
    Extract<SendResult, { sent: true; idempotent_replay?: never }>["provider_message_id"],
    string
  >>;
export type HistoricalAttachmentSlotRegression =
  Assert<Equal<Message["attachments"], Array<AttachmentMeta | null>>>;
export type BatchAttachmentMetadataRegression =
  Assert<Equal<
    BatchAttachmentsResult["by_message_id"],
    Record<string, Array<AttachmentBatchMeta>>
  >>;
