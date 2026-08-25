import { z } from 'zod';
import { commonStatusFields } from './common';
import { unvalidatedPermissionSchema } from './permission-shape';

/**
 * Duplicated from auth/roles.ts's `AppRole`/`APP_ROLES` (the api package) rather than shared
 * across packages: this is purely the zod validation enum for the `User` CRD's `role` field, a
 * 3-value literal that essentially never changes, and importing it back from the api package would
 * invert the dependency direction (schemas is meant to be the lower-level shared package).
 */
export const APP_ROLES = ['none', 'user', 'admin'] as const;

/**
 * One identity that can log in — a local username/password account, an OIDC identity tracked
 * since its first SSO login, or both once linked (`username` and `sub` both set). A real CRD (see
 * crd-meta.ts's User descriptor) like every other kind here, but `passwordHash` deliberately isn't
 * a field: it lives in a separate, narrowly RBAC-scoped Secret (auth/user-passwords.ts) so a
 * broadly-granted CRD read (`kubectl get users`, or any future `list`/`get` RBAC grant) can never
 * expose credential material, only identity/authorization metadata. Same admin-only, canAct-bypassing
 * routing as Group (see crd-meta.ts's comment on the Group descriptor) — a user editing their own
 * role/permissions via this object would be a privilege-escalation vector.
 */
export const userSpecSchema = z.object({
  /** Set for a local-loginable account (see auth/user-passwords.ts for its password hash, keyed
   * by this same username). Absent for an OIDC-only identity that has never been given one. */
  username: z.string().optional(),
  /** The OIDC `sub` claim, set once this identity has logged in via SSO at least once (tracked)
   * or been linked to a local account by matching email. Absent for a local-only account. */
  sub: z.string().optional(),
  email: z.string().optional(),
  displayName: z.string().optional(),
  impersonateGroups: z.array(z.string()).default([]),
  role: z.enum(APP_ROLES).default('none'),
  permissions: z.array(unvalidatedPermissionSchema).default([]),
});
export type UserSpec = z.infer<typeof userSpecSchema>;

// No controller reconciles a User — it's pure API-managed storage — so nothing ever populates
// these, but every kind gets a status subresource (see crd-yaml.ts), and this keeps User
// consistent with every other kind rather than a special case.
export const userStatusSchema = z.object(commonStatusFields);
export type UserStatus = z.infer<typeof userStatusSchema>;
