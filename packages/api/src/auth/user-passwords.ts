import { coreApi } from '../plugins/k8s';

/**
 * The one place a password hash is ever read or written. Kept as a small, self-contained Secret
 * blob — same "narrowly RBAC-scoped Secret, one JSON value" pattern the old `a5e-local-accounts`
 * Secret used — deliberately separate from the `User` CRD (auth/user-store.ts): a CRD is
 * kubectl-visible and covered by the same broad `a5e.k8s.rocks` CRUD RBAC every other kind gets,
 * so credential material must never live in one. Keyed by username (the natural unique key for a
 * local-loginable account; an OIDC-only identity has no entry here at all).
 */
const SECRET_NAME = 'a5e-user-passwords';

function namespace(): string {
  return process.env.POD_NAMESPACE ?? 'default';
}

async function readHashes(): Promise<Record<string, string>> {
  try {
    const secret = await coreApi.readNamespacedSecret({
      name: SECRET_NAME,
      namespace: namespace(),
    });
    const raw = secret.data?.hashes;
    if (!raw) return {};
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as Record<string, string>;
  } catch (err) {
    if ((err as { code?: number }).code === 404) return {};
    throw err;
  }
}

async function writeHashes(hashes: Record<string, string>): Promise<void> {
  const stringData = { hashes: JSON.stringify(hashes) };
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

export async function hasPasswordHash(username: string): Promise<boolean> {
  const hashes = await readHashes();
  return Boolean(hashes[username]);
}

/** One read for every "hasPassword" flag in a Users list, instead of one Secret round trip per
 * row (see user-store.ts's listUsers). */
export async function listUsernamesWithPassword(): Promise<Set<string>> {
  const hashes = await readHashes();
  return new Set(Object.keys(hashes));
}

export async function setPasswordHash(username: string, password: string): Promise<void> {
  const hashes = await readHashes();
  hashes[username] = await Bun.password.hash(password);
  await writeHashes(hashes);
}

/** Migration-only: merges in already-hashed values directly, unlike setPasswordHash (which hashes
 * a plaintext password) — used to carry a legacy passwordHash over unchanged, never decoding or
 * re-hashing it (see migrate-legacy-users.ts). A no-op for an empty map, so a migration run with
 * no local accounts at all doesn't touch this Secret. */
export async function setPasswordHashesDirect(hashes: Record<string, string>): Promise<void> {
  if (Object.keys(hashes).length === 0) return;
  const existing = await readHashes();
  await writeHashes({ ...existing, ...hashes });
}

export async function deletePasswordHash(username: string): Promise<void> {
  const hashes = await readHashes();
  if (!(username in hashes)) return;
  delete hashes[username];
  await writeHashes(hashes);
}

/** `undefined` means "no password set" (verify always fails), not the same as an incorrect one. */
export async function verifyPassword(username: string, password: string): Promise<boolean> {
  const hashes = await readHashes();
  const hash = hashes[username];
  if (!hash) return false;
  return Bun.password.verify(password, hash);
}
