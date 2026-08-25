import { z } from 'zod';
import { commonStatusFields } from './common';

export const CHANGE_ITEM_ACTIONS = ['create', 'update', 'delete'] as const;
export const changeItemActionSchema = z.enum(CHANGE_ITEM_ACTIONS);
export type ChangeItemAction = z.infer<typeof changeItemActionSchema>;

/**
 * One create/update/delete on one object, staged as part of a ChangeRequest. `type` is a CRD kind
 * name, validated against the resource registry at the route layer (not here, for a cleaner error
 * message than a bare zod enum mismatch would give). `name`/`body` requirements depend on `action`
 * (required for update/delete, required for create/update respectively) — also enforced at the
 * route layer rather than as a schema union, since a per-action-shape union produces worse
 * validation errors for a UI-authored batch than a flat object with a clear "why this failed".
 */
export const changeItemSchema = z.object({
  action: changeItemActionSchema,
  type: z.string(),
  namespace: z.string().optional(),
  name: z.string().optional(),
  body: z.unknown().optional(),
});
export type ChangeItem = z.infer<typeof changeItemSchema>;

export const changeRequestSpecSchema = z.object({
  /** Identity id (`local:<username>` or `oidc:<sub>`) — the source of truth for the self-withdraw
   * and approve/decline permission checks. Never shown to the user directly; see
   * `requestedByName` for that. */
  requestedBy: z.string(),
  /** The requester's display name, stamped once at creation time from their session — denormalized
   * so every viewer (including a non-admin reviewer with no access to the Users list) can show a
   * human-readable name without an extra lookup, and so it stays stable even if the account is
   * later renamed or removed. */
  requestedByName: z.string(),
  requestedAt: z.string(),
  reason: z.string().optional(),
  changes: z.array(changeItemSchema).min(1),
});
export type ChangeRequestSpec = z.infer<typeof changeRequestSpecSchema>;

export const CHANGE_REQUEST_PHASES = [
  'Pending',
  'Approved',
  'Declined',
  'Applied',
  'Failed',
] as const;
export const changeRequestPhaseSchema = z.enum(CHANGE_REQUEST_PHASES);
export type ChangeRequestPhase = z.infer<typeof changeRequestPhaseSchema>;

export const CHANGE_ITEM_RESULT_STATUSES = ['Applied', 'Failed', 'Skipped'] as const;

export const changeRequestStatusSchema = z.object({
  ...commonStatusFields,
  phase: changeRequestPhaseSchema.optional(),
  reviewedBy: z.string().optional(),
  /** Same denormalization rationale as `requestedByName` — stamped once at approve/decline time. */
  reviewedByName: z.string().optional(),
  reviewedAt: z.string().optional(),
  declineReason: z.string().optional(),
  results: z
    .array(
      z.object({
        index: z.number().int(),
        status: z.enum(CHANGE_ITEM_RESULT_STATUSES),
        error: z.string().optional(),
      }),
    )
    .optional(),
});
export type ChangeRequestStatus = z.infer<typeof changeRequestStatusSchema>;
