import { createLocalAccount, hasAnyLocalAccount } from './user-store';

/**
 * Creates exactly one local admin account on first startup, if no local accounts exist yet —
 * the on-ramp for a fresh install (replaces the old AUTH_MODE=dev-bypass shortcut, which
 * authenticated every request as a fixed identity regardless of any real login and was too easy
 * to leave on by accident). Never touches an existing account, so BOOTSTRAP_ADMIN_USERNAME/
 * PASSWORD can be left set indefinitely (e.g. in a local .env) — this only ever does anything
 * the very first time no local account exists yet (see auth/user-store.ts).
 */
export async function bootstrapAdminAccount(): Promise<void> {
  const username = process.env.BOOTSTRAP_ADMIN_USERNAME;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!username || !password) return;

  if (await hasAnyLocalAccount().catch(() => false)) return;

  await createLocalAccount({
    username,
    password,
    impersonateGroups: ['a5e-admins'],
    role: 'admin',
  });
  console.log(
    `bootstrapped initial local admin account "${username}" — BOOTSTRAP_ADMIN_USERNAME/PASSWORD can be unset now`,
  );
}
