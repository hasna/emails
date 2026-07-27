// Diagnostics identity for a store. FOR HUMANS AND LOGS ONLY.
//
// BRANCHING ON THIS IS FORBIDDEN. Not discouraged — forbidden. This field is what
// `MailDataSource.mode` became: it was introduced as a label, it was typed as a
// two-value union, and because a union narrows so pleasantly it leaked out. Counted
// precisely rather than approximately: five call sites BRANCH on it —
// src/cli/commands/send.ts:136 and src/cli/commands/inbox.local.ts:178, 496, 1006, 1011
// — plus three that pass it through (src/cli/commands/inbox.remote.ts:427, 679 and the
// TUI state). Every branch is a deployment-mode decision wearing a data-source costume,
// and they are exactly what the store seam exists to delete. A second label with the
// same shape would rebuild them.
//
// (The `mode.mode === "self_hosted"` checks in src/lib/doctor.local.ts are a DIFFERENT
// thing — they read the deployment-mode variable directly, not this label. Conflating the two
// would overstate the case.)
//
// So the shape here is deliberately HOSTILE to branching:
//
//   * `kind` is `string`, NOT a union of the known store names. A comparison like
//     `descriptor.kind === "sqlite"` therefore narrows NOTHING, no `switch` over it
//     can ever be exhaustive, and no `never` check will prove all cases handled. The
//     ergonomics that made `mode` spread are absent on purpose.
//   * Everything is `readonly`, so it cannot be reassigned to signal state.
//   * There are no booleans, no capability hints, and no URL. Whether an operation
//     is possible is answered by StoreCapabilities; where the data lives is not the
//     caller's business.
//
// If a caller needs to know whether something is POSSIBLE, that is a capability. If
// it needs to know whether something SUCCEEDED, that is an Outcome. Neither question
// is ever answered by asking what kind of store this is.

export interface StoreDescriptor {
  /**
   * Short identifier for logs and `doctor` output, e.g. `"sqlite"` or `"api"`.
   *
   * Typed `string` deliberately — see the note above. This is the one place in the
   * seam where a wider type is the safer type.
   */
  readonly kind: string;

  /**
   * Human-readable summary for diagnostics, e.g. `"SQLite at ~/.emails/emails.db"`
   * or `"Emails API at https://mail.example.com"`.
   *
   * MUST be safe to print: never a credential, never a token, never a query string.
   */
  readonly detail: string;
}
