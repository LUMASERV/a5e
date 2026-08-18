import { coreApi } from '../plugins/k8s';
import { findLocalAccountByUsername } from './local-accounts';
import type { Session } from './session';

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

/** Tracks the role for OIDC identities that were never linked to a local account (see
 * auth/local-accounts.ts) — a local account's own `role` field is authoritative once linked.
 * A ConfigMap, not a Secret: nothing sensitive here, just `sub -> {role, email, displayName}`. */
const CONFIGMAP_NAME = 'a5e-oidc-user-roles';

function namespace(): string {
  return process.env.POD_NAMESPACE ?? 'default';
}

export interface OidcUserRoleEntry {
  sub: string;
  email?: string;
  displayName?: string;
  role: AppRole;
}

async function readOidcUserRoles(): Promise<OidcUserRoleEntry[]> {
  try {
    const cm = await coreApi.readNamespacedConfigMap({ name: CONFIGMAP_NAME, namespace: namespace() });
    const raw = cm.data?.users;
    if (!raw) return [];
    return JSON.parse(raw) as OidcUserRoleEntry[];
  } catch (err) {
    if ((err as { code?: number }).code === 404) return [];
    throw err;
  }
}

async function writeOidcUserRoles(entries: OidcUserRoleEntry[]): Promise<void> {
  const data = { users: JSON.stringify(entries) };
  try {
    await coreApi.replaceNamespacedConfigMap({
      name: CONFIGMAP_NAME,
      namespace: namespace(),
      body: { metadata: { name: CONFIGMAP_NAME }, data },
    });
  } catch (err) {
    if ((err as { code?: number }).code !== 404) throw err;
    await coreApi.createNamespacedConfigMap({ namespace: namespace(), body: { metadata: { name: CONFIGMAP_NAME }, data } });
  }
}

export async function listOidcUserRoles(): Promise<OidcUserRoleEntry[]> {
  return readOidcUserRoles();
}

export async function setOidcUserRole(sub: string, role: AppRole): Promise<void> {
  const entries = await readOidcUserRoles();
  const existing = entries.find((e) => e.sub === sub);
  if (existing) existing.role = role;
  else entries.push({ sub, role });
  await writeOidcUserRoles(entries);
}

export async function deleteOidcUserRole(sub: string): Promise<void> {
  const entries = await readOidcUserRoles();
  await writeOidcUserRoles(entries.filter((e) => e.sub !== sub));
}

/** Called once per OIDC login for a not-linked-to-a-local-account identity — creates a `role:
 * 'none'` placeholder on first sight (so an admin has something to find and promote) and keeps
 * email/displayName fresh on every subsequent login, but never touches an already-set role. */
export async function trackOidcLogin(sub: string, email: string | undefined, displayName: string): Promise<void> {
  const entries = await readOidcUserRoles();
  const existing = entries.find((e) => e.sub === sub);
  if (existing) {
    existing.email = email;
    existing.displayName = displayName;
  } else {
    entries.push({ sub, email, displayName, role: 'none' });
  }
  await writeOidcUserRoles(entries);
}

/**
 * Resolves the current app role fresh on every call (never cached in the session cookie) so a
 * role change by an admin takes effect on the user's very next request, not just their next login.
 */
export async function resolveRole(session: Session): Promise<AppRole> {
  // `session.kind` is an explicit discriminant set once at login time (auth/routes.ts) — never
  // inferred from `impersonateUser`'s string shape. That string doubles as the literal Kubernetes
  // `Impersonate-User` value cluster admins bind real RBAC to, so a maliciously-configured IdP
  // issuing a `sub` like "local:admin" must never be mistaken for the local `admin` account.
  if (session.kind === 'local') {
    const username = session.identity.impersonateUser.slice('local:'.length);
    const account = await findLocalAccountByUsername(username);
    return account?.role ?? 'none';
  }
  const sub = session.identity.impersonateUser;
  const entries = await readOidcUserRoles();
  return entries.find((e) => e.sub === sub)?.role ?? 'none';
}
