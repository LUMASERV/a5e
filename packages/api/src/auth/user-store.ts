import { API_GROUP_VERSION, RESOURCE_DESCRIPTORS_BY_KIND } from '@a5e/schemas';
import type { CustomResource, Permission, UserSpec, UserStatus } from '@a5e/schemas';
import { client } from '../plugins/k8s';
import type { AppRole } from './roles';
import type { Session } from './session';
import {
  deletePasswordHash,
  hasPasswordHash,
  listUsernamesWithPassword,
  setPasswordHash,
  verifyPassword,
} from './user-passwords';

/**
 * Every identity that can log in, as a real `User` CRD (see crd-meta.ts) — replaces the old
 * `a5e-local-accounts` Secret blob + `a5e-oidc-user-roles` ConfigMap blob design. Password hashes
 * stay out of this file's CR spec entirely; see user-passwords.ts for the one place they're
 * touched.
 */
const descriptor = RESOURCE_DESCRIPTORS_BY_KIND.User!;
type UserCR = CustomResource<UserSpec, UserStatus>;

function isNotFound(err: unknown): boolean {
  return (err as { code?: number }).code === 404;
}

/** k8s object names must be DNS-1123 subdomains; usernames/OIDC `sub`s aren't guaranteed to be —
 * sanitize and prefix by kind so a local account and an OIDC-only identity can never collide on
 * name even if their sanitized forms happen to match. */
function sanitizeSegment(raw: string): string {
  const sanitized = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || 'x';
}
// Exported for migrate-legacy-users.ts, which must derive the exact same CR name a normal
// login/lookup would, for a migrated identity to actually resolve afterward.
export function localCRName(username: string): string {
  return `local-${sanitizeSegment(username)}`.slice(0, 253);
}
export function oidcCRName(sub: string): string {
  return `oidc-${sanitizeSegment(sub)}`.slice(0, 253);
}

async function getUserCR(name: string): Promise<UserCR | undefined> {
  try {
    return await client.get<UserCR>(descriptor, name, 'self');
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

async function listUserCRs(): Promise<UserCR[]> {
  const result = await client.list<UserCR>(descriptor, 'self');
  return result.items;
}

async function createUserCR(name: string, spec: Record<string, unknown>): Promise<UserCR> {
  return client.create<UserCR>(
    descriptor,
    { apiVersion: API_GROUP_VERSION, kind: 'User', metadata: { name }, spec },
    'self',
  );
}

/** Used only by migrate-legacy-users.ts: creates a `User` CR only if one with that derived name
 * doesn't already exist, so a from-scratch migration across a rolling restart (or a retry after a
 * partial failure) never double-creates or errors on an identity it already migrated. */
export async function createUserCRIfAbsent(
  name: string,
  spec: Record<string, unknown>,
): Promise<'created' | 'exists'> {
  if (await getUserCR(name)) return 'exists';
  await createUserCR(name, spec);
  return 'created';
}

/** Merge-patch — a `null` value clears a field (RFC 7396), `undefined` (dropped by JSON.stringify)
 * leaves it untouched. Loosely typed rather than `Partial<UserSpec>` so callers can pass `null`
 * to clear a field, which `UserSpec`'s own field types don't allow. */
async function patchUserCR(name: string, patch: Record<string, unknown>): Promise<UserCR> {
  return client.patch<UserCR>(descriptor, name, { spec: patch }, 'self');
}

async function deleteUserCR(name: string): Promise<void> {
  try {
    await client.delete(descriptor, name, 'self');
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

/** Used by permission-engine.ts (direct grants) and roles.ts (resolveRole) — a single O(1) lookup
 * by the caller's own session identity, since the CR name is deterministically derived from it. */
export async function findUserBySession(session: Session): Promise<UserCR | undefined> {
  if (session.kind === 'local') {
    const username = session.identity.impersonateUser.slice('local:'.length);
    return getUserCR(localCRName(username));
  }
  return getUserCR(oidcCRName(session.identity.impersonateUser));
}

export async function hasAnyLocalAccount(): Promise<boolean> {
  const users = await listUserCRs();
  return users.some((u) => u.spec.username);
}

export interface LocalIdentity {
  username: string;
  impersonateGroups: string[];
  displayName?: string;
  email?: string;
}

function toLocalIdentity(cr: UserCR): LocalIdentity {
  return {
    username: cr.spec.username!,
    impersonateGroups: cr.spec.impersonateGroups,
    displayName: cr.spec.displayName,
    email: cr.spec.email,
  };
}

export async function verifyLocalLogin(
  username: string,
  password: string,
): Promise<LocalIdentity | undefined> {
  const valid = await verifyPassword(username, password);
  if (!valid) return undefined;
  const cr = await getUserCR(localCRName(username));
  return cr ? toLocalIdentity(cr) : undefined;
}

export async function findAccountBySub(sub: string): Promise<LocalIdentity | undefined> {
  // A linked local account's CR name is derived from its username, not its sub — a full list scan
  // is the only way to find "the local account whose sub is this one", same cost as the previous
  // ConfigMap/Secret-blob design's full-list-and-find.
  const users = await listUserCRs();
  const match = users.find((u) => u.spec.username && u.spec.sub === sub);
  return match ? toLocalIdentity(match) : undefined;
}

/** See LocalAccount.linkedSub's old doc comment (now UserSpec.sub) for the email-match rules this
 * implements — requires a *verified* email claim, never an attacker-settable unverified one. */
export async function linkAccountToSub(
  email: string | undefined,
  emailVerified: boolean,
  sub: string,
): Promise<LocalIdentity | undefined> {
  if (!email || !emailVerified) return undefined;
  const users = await listUserCRs();
  const match = users.find(
    (u) => u.spec.username && u.spec.email?.toLowerCase() === email.toLowerCase(),
  );
  if (!match) return undefined;
  if (match.spec.sub) return match.spec.sub === sub ? toLocalIdentity(match) : undefined;
  await patchUserCR(match.metadata.name, { sub });
  return toLocalIdentity(match);
}

export async function changeOwnPassword(
  username: string,
  currentPassword: string | undefined,
  newPassword: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const cr = await getUserCR(localCRName(username));
  if (!cr) return { ok: false, error: 'account not found' };
  if (await hasPasswordHash(username)) {
    if (!currentPassword) return { ok: false, error: 'current password is required' };
    if (!(await verifyPassword(username, currentPassword))) {
      return { ok: false, error: 'current password is incorrect' };
    }
  }
  await setPasswordHash(username, newPassword);
  return { ok: true };
}

/** Called once per OIDC login for a not-linked-to-a-local-account identity — creates a `role:
 * 'none'` placeholder on first sight (so an admin has something to find and promote) and keeps
 * email/displayName fresh on every subsequent login, but never touches an already-set role. */
export async function trackOidcLogin(
  sub: string,
  email: string | undefined,
  displayName: string,
): Promise<void> {
  const name = oidcCRName(sub);
  const existing = await getUserCR(name);
  if (existing) {
    await patchUserCR(name, { email: email ?? null, displayName });
    return;
  }
  await createUserCR(name, {
    sub,
    email,
    displayName,
    impersonateGroups: [],
    role: 'none',
    permissions: [],
  });
}

// ---- Admin-facing CRUD (modules/users-settings.ts) ----

export interface CreateAccountInput {
  username: string;
  /** Optional: omit to pre-create an identity (role/groups/email) for a user who'll first arrive
   * via SSO — see UserSpec's doc comment. */
  password?: string;
  email?: string;
  displayName?: string;
  impersonateGroups: string[];
  role: AppRole;
  permissions?: Permission[];
}

export async function createLocalAccount(input: CreateAccountInput): Promise<void> {
  const name = localCRName(input.username);
  if (await getUserCR(name)) {
    throw new Error(`local account "${input.username}" already exists`);
  }
  await createUserCR(name, {
    username: input.username,
    email: input.email,
    displayName: input.displayName,
    impersonateGroups: input.impersonateGroups,
    role: input.role,
    permissions: input.permissions ?? [],
  });
  if (input.password) await setPasswordHash(input.username, input.password);
}

/**
 * Promotes an SSO-only identity (never previously linked) into a full local account with an
 * admin-chosen username, immediately linked to its `sub` — the manual equivalent of
 * `linkAccountToSub`'s automatic email match, for when an admin wants to hand that person a local
 * username/password without waiting on (or requiring) an email-scope-based login match.
 */
export async function createLinkedLocalAccount(
  username: string,
  linkedSub: string,
  input: {
    password?: string;
    email?: string;
    displayName?: string;
    impersonateGroups: string[];
    role: AppRole;
    permissions?: Permission[];
  },
): Promise<void> {
  const name = localCRName(username);
  if (await getUserCR(name)) throw new Error(`local account "${username}" already exists`);
  const users = await listUserCRs();
  if (users.some((u) => u.spec.username && u.spec.sub === linkedSub)) {
    throw new Error('this SSO identity is already linked to a local account');
  }
  await createUserCR(name, {
    username,
    sub: linkedSub,
    email: input.email,
    displayName: input.displayName,
    impersonateGroups: input.impersonateGroups,
    role: input.role,
    permissions: input.permissions ?? [],
  });
  if (input.password) await setPasswordHash(username, input.password);
  // Clean up the stale pre-promotion oidc- tracking CR, now superseded by the linked local- one —
  // an improvement the CRD move enables: the old ConfigMap-blob design just left that entry
  // sitting there, hidden by a listing filter. A real CRD is kubectl-visible, so leaving a
  // duplicate object around would be worse hygiene than a hidden blob entry ever was.
  await deleteUserCR(oidcCRName(linkedSub));
}

/** Combined view over every identity that can log in — the single data structure behind the
 * "Users" settings page. `id` is `local:<username>` for a local account or `oidc:<sub>` for an
 * unlinked SSO identity — an app-level identifier only, deliberately NOT the same string used for
 * `session.identity.impersonateUser` (see the old auth/users.ts's doc comment: prefixing prevents
 * an attacker-supplied OIDC `sub` like `"local:admin"` from colliding with the real local account). */
export interface AppUser {
  id: string;
  username?: string;
  sub?: string;
  email?: string;
  displayName?: string;
  impersonateGroups: string[];
  role: AppRole;
  hasPassword: boolean;
  permissions: Permission[];
}

function appUserId(cr: UserCR): string {
  return cr.spec.username ? `local:${cr.spec.username}` : `oidc:${cr.spec.sub}`;
}

export async function listUsers(): Promise<AppUser[]> {
  const [crs, withPassword] = await Promise.all([listUserCRs(), listUsernamesWithPassword()]);
  return crs.map((cr) => ({
    id: appUserId(cr),
    username: cr.spec.username,
    sub: cr.spec.sub,
    email: cr.spec.email,
    displayName: cr.spec.displayName,
    impersonateGroups: cr.spec.impersonateGroups,
    role: cr.spec.role as AppRole,
    hasPassword: Boolean(cr.spec.username && withPassword.has(cr.spec.username)),
    permissions: (cr.spec.permissions ?? []) as Permission[],
  }));
}

/** `updateUser`'s patch shape — `username` is only meaningful for an `oidc:`-prefixed id, where
 * providing one promotes that SSO-only identity into a fully linked local account (see
 * createLinkedLocalAccount above) so it can be given a local password. Ignored for `local:` ids,
 * whose username is immutable once created. */
export interface UserUpdate {
  username?: string;
  email?: string;
  displayName?: string;
  impersonateGroups?: string[];
  role?: AppRole;
  /** Sets/resets the password when present — an admin action, no current-password check (see
   * changeOwnPassword above for the self-service, current-password-checked equivalent). */
  password?: string;
  permissions?: Permission[];
}

/**
 * Applies a partial edit to any row from listUsers() above. For an `oidc:`-prefixed (SSO-only) id
 * with no `username` in the patch, only `role`/`permissions` are meaningful — there's no local
 * account yet to hold the other fields — so the route layer (modules/users-settings.ts) rejects a
 * request that tries to set them without also providing a `username`. Providing one promotes the
 * identity into a real linked local account in the same call (see createLinkedLocalAccount).
 */
export async function updateUser(id: string, patch: UserUpdate): Promise<void> {
  if (id.startsWith('local:')) {
    const username = id.slice('local:'.length);
    const specPatch: Record<string, unknown> = {};
    if (patch.email !== undefined) specPatch.email = patch.email || null;
    if (patch.displayName !== undefined) specPatch.displayName = patch.displayName || null;
    if (patch.impersonateGroups !== undefined) {
      specPatch.impersonateGroups = patch.impersonateGroups;
    }
    if (patch.role !== undefined) specPatch.role = patch.role;
    if (patch.permissions !== undefined) specPatch.permissions = patch.permissions;
    if (Object.keys(specPatch).length > 0) await patchUserCR(localCRName(username), specPatch);
    if (patch.password) await setPasswordHash(username, patch.password);
    return;
  }
  if (id.startsWith('oidc:')) {
    const sub = id.slice('oidc:'.length);
    if (patch.username) {
      const existing = await getUserCR(oidcCRName(sub));
      await createLinkedLocalAccount(patch.username, sub, {
        password: patch.password,
        email: patch.email ?? existing?.spec.email,
        displayName: patch.displayName ?? existing?.spec.displayName,
        impersonateGroups: patch.impersonateGroups ?? [],
        role: patch.role ?? (existing?.spec.role as AppRole | undefined) ?? 'none',
        permissions: (patch.permissions ?? existing?.spec.permissions) as Permission[] | undefined,
      });
      return;
    }
    const specPatch: Record<string, unknown> = {};
    if (patch.role !== undefined) specPatch.role = patch.role;
    if (patch.permissions !== undefined) specPatch.permissions = patch.permissions;
    if (Object.keys(specPatch).length > 0) await patchUserCR(oidcCRName(sub), specPatch);
    return;
  }
  throw new Error(`unrecognized user id "${id}"`);
}

export async function deleteUser(id: string): Promise<void> {
  if (id.startsWith('local:')) {
    const username = id.slice('local:'.length);
    await deleteUserCR(localCRName(username));
    await deletePasswordHash(username);
  } else if (id.startsWith('oidc:')) {
    await deleteUserCR(oidcCRName(id.slice('oidc:'.length)));
  } else {
    throw new Error(`unrecognized user id "${id}"`);
  }
}
