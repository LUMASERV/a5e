import type { Session } from './session';
import { findUserBySession } from './user-store';

/**
 * App-level authorization layer, separate from and on top of Kubernetes RBAC: RBAC still governs
 * what impersonated k8s calls can actually do, but a brand-new identity (OIDC sub or local
 * account) needs *some* gate before that — otherwise every fresh login hits raw k8s 403s on
 * every list/get call, which is confusing and (see auth/index.ts's global error handler) used to
 * surface as an opaque 500. `none` is the default for anyone not explicitly promoted: can log in,
 * can't do anything else. `user` can use the app; `admin` can additionally reach Settings.
 */
export const APP_ROLES = ['none', 'user', 'admin'] as const;
export type AppRole = (typeof APP_ROLES)[number];

const ROLE_ORDER: Record<AppRole, number> = { none: 0, user: 1, admin: 2 };

export function roleAtLeast(role: AppRole, min: Exclude<AppRole, 'none'>): boolean {
  return ROLE_ORDER[role] >= ROLE_ORDER[min];
}

/**
 * Resolves the current app role fresh on every call (never cached in the session cookie) so a
 * role change by an admin takes effect on the user's very next request, not just their next login.
 */
export async function resolveRole(session: Session): Promise<AppRole> {
  const user = await findUserBySession(session);
  return (user?.spec.role as AppRole | undefined) ?? 'none';
}
