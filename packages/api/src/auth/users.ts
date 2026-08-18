import { deleteLocalAccount, listLocalAccounts, setLocalAccountRole } from './local-accounts';
import { deleteOidcUserRole, listOidcUserRoles, setOidcUserRole } from './roles';
import type { AppRole } from './roles';

/**
 * Combined view over every identity that can log in (see auth/local-accounts.ts and
 * auth/roles.ts's OIDC-user-roles store) — the single data structure behind the "Users" settings
 * page. A local account whose `linkedSub` matches an OIDC-user-roles entry (see
 * local-accounts.ts's linkAccountToSub) collapses into one row with both `username` and `sub`
 * set; the underlying OIDC-user-roles entry for that sub is then just a stale pre-link artifact
 * and is hidden here rather than shown as a duplicate. `id` is `local:<username>` for a local account or `oidc:<sub>` for an unlinked SSO identity —
 * an app-level identifier only, deliberately NOT the same string used for
 * `session.identity.impersonateUser` (the literal Kubernetes `Impersonate-User` value, which stays
 * an unprefixed raw `sub` for OIDC — see auth/routes.ts). Prefixing here too matters because `sub`
 * is attacker-supplied by whatever IdP is configured: an unprefixed id would let a crafted
 * `sub: "local:admin"` collide with a real local account's id, so an admin clicking what the UI
 * shows as an SSO row could end up mutating the actual local `admin` account instead.
 */
export interface AppUser {
  id: string;
  username?: string;
  sub?: string;
  email?: string;
  displayName?: string;
  impersonateGroups: string[];
  role: AppRole;
  /** Whether a local username/password login exists for this row (false for SSO-only rows, which
   * only ever log in via the IdP and can't be deleted the way a local account can — they simply
   * reappear with a fresh `role: 'none'` on their next login). */
  hasPassword: boolean;
}

export async function listUsers(): Promise<AppUser[]> {
  const [accounts, oidcEntries] = await Promise.all([listLocalAccounts(), listOidcUserRoles()]);
  const linkedSubs = new Set(accounts.map((a) => a.linkedSub).filter((sub): sub is string => !!sub));

  const local: AppUser[] = accounts.map((a) => ({
    id: `local:${a.username}`,
    username: a.username,
    sub: a.linkedSub,
    email: a.email,
    displayName: a.displayName,
    impersonateGroups: a.impersonateGroups,
    role: a.role,
    hasPassword: true,
  }));

  const ssoOnly: AppUser[] = oidcEntries
    .filter((e) => !linkedSubs.has(e.sub))
    .map((e) => ({
      id: `oidc:${e.sub}`,
      sub: e.sub,
      email: e.email,
      displayName: e.displayName,
      impersonateGroups: [],
      role: e.role,
      hasPassword: false,
    }));

  return [...local, ...ssoOnly];
}

export async function setUserRole(id: string, role: AppRole): Promise<void> {
  if (id.startsWith('local:')) await setLocalAccountRole(id.slice('local:'.length), role);
  else if (id.startsWith('oidc:')) await setOidcUserRole(id.slice('oidc:'.length), role);
  else throw new Error(`unrecognized user id "${id}"`);
}

export async function deleteUser(id: string): Promise<void> {
  if (id.startsWith('local:')) await deleteLocalAccount(id.slice('local:'.length));
  else if (id.startsWith('oidc:')) await deleteOidcUserRole(id.slice('oidc:'.length));
  else throw new Error(`unrecognized user id "${id}"`);
}
