import { coreApi } from '../plugins/k8s';
import type { AppRole } from './roles';

/**
 * Local username/password accounts — a fallback login path independent of the IdP, and how an
 * initial admin identity gets bootstrapped before any OIDC group→RBAC mapping exists. Stored as
 * one JSON blob in a Secret (not per-account keys): avoids sanitizing usernames into valid
 * Secret data-key names, and the whole list is small enough that whole-list read/write is fine.
 * Same "API's own identity, narrowly-scoped RBAC" model as lib/oidc-config-store.ts.
 */
const SECRET_NAME = 'a5e-local-accounts';

function namespace(): string {
  return process.env.POD_NAMESPACE ?? 'default';
}

export interface LocalAccount {
  username: string;
  passwordHash: string;
  email?: string;
  displayName?: string;
  impersonateGroups: string[];
  /** App-level role (see auth/roles.ts) — defaults to 'none' (log in, do nothing) for any
   * account created without one specified, same as a fresh unrecognized OIDC identity. */
  role: AppRole;
  /** Set once an OIDC login's `sub` has been matched to this account by email (see linkAccountToSub) — from then on, that OIDC identity resolves to this same account's impersonation identity. */
  linkedSub?: string;
}

export type PublicLocalAccount = Omit<LocalAccount, 'passwordHash'>;

export function toPublic(account: LocalAccount): PublicLocalAccount {
  const { passwordHash: _passwordHash, ...pub } = account;
  return pub;
}

async function readAccounts(): Promise<LocalAccount[]> {
  try {
    const secret = await coreApi.readNamespacedSecret({
      name: SECRET_NAME,
      namespace: namespace(),
    });
    const raw = secret.data?.accounts;
    if (!raw) return [];
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as LocalAccount[];
  } catch (err) {
    if ((err as { code?: number }).code === 404) return [];
    throw err;
  }
}

async function writeAccounts(accounts: LocalAccount[]): Promise<void> {
  const stringData = { accounts: JSON.stringify(accounts) };
  try {
    await coreApi.replaceNamespacedSecret({
      name: SECRET_NAME,
      namespace: namespace(),
      body: { metadata: { name: SECRET_NAME }, type: 'Opaque', stringData },
    });
  } catch (err) {
    if ((err as { code?: number }).code !== 404) throw err;
    await coreApi.createNamespacedSecret({
      namespace: namespace(),
      body: { metadata: { name: SECRET_NAME }, type: 'Opaque', stringData },
    });
  }
}

export async function listLocalAccounts(): Promise<PublicLocalAccount[]> {
  return (await readAccounts()).map(toPublic);
}

export async function createLocalAccount(input: {
  username: string;
  password: string;
  email?: string;
  displayName?: string;
  impersonateGroups: string[];
  role: AppRole;
}): Promise<void> {
  const accounts = await readAccounts();
  if (accounts.some((a) => a.username === input.username)) {
    throw new Error(`local account "${input.username}" already exists`);
  }
  const passwordHash = await Bun.password.hash(input.password);
  accounts.push({
    username: input.username,
    passwordHash,
    email: input.email,
    displayName: input.displayName,
    impersonateGroups: input.impersonateGroups,
    role: input.role,
  });
  await writeAccounts(accounts);
}

export async function deleteLocalAccount(username: string): Promise<void> {
  const accounts = await readAccounts();
  await writeAccounts(accounts.filter((a) => a.username !== username));
}

export async function setLocalAccountRole(username: string, role: AppRole): Promise<void> {
  const accounts = await readAccounts();
  const account = accounts.find((a) => a.username === username);
  if (!account) throw new Error(`local account "${username}" not found`);
  account.role = role;
  await writeAccounts(accounts);
}

export async function findLocalAccountByUsername(
  username: string,
): Promise<LocalAccount | undefined> {
  return (await readAccounts()).find((a) => a.username === username);
}

export async function verifyLocalLogin(
  username: string,
  password: string,
): Promise<LocalAccount | undefined> {
  const account = (await readAccounts()).find((a) => a.username === username);
  if (!account) return undefined;
  const valid = await Bun.password.verify(password, account.passwordHash);
  return valid ? account : undefined;
}

export async function findAccountBySub(sub: string): Promise<LocalAccount | undefined> {
  return (await readAccounts()).find((a) => a.linkedSub === sub);
}

/**
 * First OIDC login for a given `sub`: if a local account exists with a matching email (and isn't
 * already linked to a *different* sub — one email should only ever auto-link once), link it and
 * return it so this and every future login with that sub resolves to the account's identity.
 * Requires the IdP to actually send an `email` claim, which needs the "email" scope requested —
 * not in the default scope list (see auth/oidc.ts), so this is a no-op until that's added.
 *
 * Requires `emailVerified` — an IdP-asserted but unverified email claim must never be trusted
 * here: some IdPs let a user set an arbitrary email on their own profile before verifying it,
 * which would otherwise let an attacker link their own OIDC identity to (and inherit the role and
 * impersonation groups of) any local account just by knowing its email address.
 */
export async function linkAccountToSub(
  email: string | undefined,
  emailVerified: boolean,
  sub: string,
): Promise<LocalAccount | undefined> {
  if (!email || !emailVerified) return undefined;
  const accounts = await readAccounts();
  const match = accounts.find((a) => a.email?.toLowerCase() === email.toLowerCase());
  if (!match || match.linkedSub) return match?.linkedSub === sub ? match : undefined;
  match.linkedSub = sub;
  await writeAccounts(accounts);
  return match;
}
