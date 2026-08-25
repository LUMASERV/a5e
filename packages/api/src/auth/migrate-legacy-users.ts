import { coreApi } from '../plugins/k8s';
import { setPasswordHashesDirect } from './user-passwords';
import { createUserCRIfAbsent, localCRName, oidcCRName } from './user-store';

/**
 * Auto-runs once at every API startup (see index.ts) — this is an open-source project, so a
 * migration can't depend on every operator remembering to run a manual script after upgrading
 * past the old ConfigMap/Secret-blob accounts store to the `User` CRD (see auth/user-store.ts).
 * Uses the API's own already-provisioned RBAC, same as everything else here — no separate kubectl
 * access needed, and it just works on `helm upgrade` like any other schema change this project
 * ships.
 *
 * No-op after the first successful run: it only does anything the one time the legacy
 * `a5e-local-accounts` Secret still exists, and deletes it (and the legacy
 * `a5e-oidc-user-roles` ConfigMap) once every account has a corresponding `User` CR — so this
 * check is a single 404 read on every boot after that, indefinitely. Every create is
 * idempotent (createUserCRIfAbsent), so a retry after a partial failure (pod restart mid-migration,
 * a transient k8s API error) just picks up where it left off rather than erroring or duplicating.
 */
const LEGACY_SECRET_NAME = 'a5e-local-accounts';
const LEGACY_CONFIGMAP_NAME = 'a5e-oidc-user-roles';

function namespace(): string {
  return process.env.POD_NAMESPACE ?? 'default';
}

function isNotFound(err: unknown): boolean {
  return (err as { code?: number }).code === 404;
}

interface LegacyLocalAccount {
  username: string;
  passwordHash?: string;
  email?: string;
  displayName?: string;
  impersonateGroups: string[];
  role: 'none' | 'user' | 'admin';
  linkedSub?: string;
  permissions?: unknown[];
}

interface LegacyOidcUserRoleEntry {
  sub: string;
  email?: string;
  displayName?: string;
  role: 'none' | 'user' | 'admin';
  permissions?: unknown[];
}

export async function migrateLegacyUsersIfNeeded(): Promise<void> {
  const secret = await coreApi
    .readNamespacedSecret({ name: LEGACY_SECRET_NAME, namespace: namespace() })
    .catch((err) => {
      if (isNotFound(err)) return undefined;
      throw err;
    });
  if (!secret) return; // Fresh install, or already migrated and cleaned up — the common case.

  console.log('found a legacy local-accounts store — migrating it to the User CRD...');

  const accounts: LegacyLocalAccount[] = secret.data?.accounts
    ? JSON.parse(Buffer.from(secret.data.accounts, 'base64').toString('utf8'))
    : [];

  const configMap = await coreApi
    .readNamespacedConfigMap({ name: LEGACY_CONFIGMAP_NAME, namespace: namespace() })
    .catch((err) => {
      if (isNotFound(err)) return undefined;
      throw err;
    });
  const oidcEntries: LegacyOidcUserRoleEntry[] = configMap?.data?.users
    ? JSON.parse(configMap.data.users)
    : [];

  const passwordHashes: Record<string, string> = {};
  let created = 0;

  for (const account of accounts) {
    const result = await createUserCRIfAbsent(localCRName(account.username), {
      username: account.username,
      sub: account.linkedSub,
      email: account.email,
      displayName: account.displayName,
      impersonateGroups: account.impersonateGroups,
      role: account.role,
      permissions: account.permissions ?? [],
    });
    if (result === 'created') created++;
    if (account.passwordHash) passwordHashes[account.username] = account.passwordHash;
  }

  // A local account already linked to an OIDC sub supersedes that sub's standalone tracking
  // entry — don't create a duplicate oidc- CR for it (matches the old auth/users.ts listing's
  // dedup rule).
  const linkedSubs = new Set(
    accounts.map((a) => a.linkedSub).filter((sub): sub is string => Boolean(sub)),
  );
  for (const entry of oidcEntries) {
    if (linkedSubs.has(entry.sub)) continue;
    const result = await createUserCRIfAbsent(oidcCRName(entry.sub), {
      sub: entry.sub,
      email: entry.email,
      displayName: entry.displayName,
      impersonateGroups: [],
      role: entry.role,
      permissions: entry.permissions ?? [],
    });
    if (result === 'created') created++;
  }

  await setPasswordHashesDirect(passwordHashes);

  // Only ever deletes the OLD store, never the new one. If either delete fails, this whole
  // function just runs again next boot — every step above is already idempotent, so that's
  // harmless, not a retry loop that redoes real work.
  await coreApi
    .deleteNamespacedSecret({ name: LEGACY_SECRET_NAME, namespace: namespace() })
    .catch(() => {});
  if (configMap) {
    await coreApi
      .deleteNamespacedConfigMap({ name: LEGACY_CONFIGMAP_NAME, namespace: namespace() })
      .catch(() => {});
  }

  console.log(`migrated ${created} account(s) to the User CRD and removed the legacy store.`);
}
