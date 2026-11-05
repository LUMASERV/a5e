import { randomBytes } from 'node:crypto';
import type { Session } from './session';

/**
 * In-memory session + PKCE-state store. Fine for a single API replica (today's deployment
 * shape); a horizontally-scaled API would need this backed by something shared (e.g. a Secret
 * or an external cache) instead — noted here as a follow-up, not solved now.
 */
const sessions = new Map<string, { session: Session; createdAt: number }>();

/**
 * Hard upper bound on how long one login stays usable. Sessions used to live until an explicit
 * logout, which meant a leaked token (it sits in the browser's localStorage — see ui/src/api/
 * token.ts) worked forever, the map only ever grew, and an OIDC identity's group memberships —
 * which are snapshotted from the ID token at login and can't be re-read from the cluster — could
 * never be revoked. Expiry bounds all three. Local accounts don't wait this long: their groups
 * are re-read from the `User` CR on every request (see auth/permission-engine.ts).
 */
const SESSION_TTL_MS = 12 * 60 * 60_000;

interface PendingLogin {
  codeVerifier: string;
  createdAt: number;
}
const pendingLogins = new Map<string, PendingLogin>();
const PENDING_LOGIN_TTL_MS = 5 * 60_000;

export function createSessionId(): string {
  return randomBytes(32).toString('hex');
}

export function storeSession(sessionId: string, session: Session): void {
  sessions.set(sessionId, { session, createdAt: Date.now() });
  // Sweep on write, same as storePendingLogin below — logins are rare enough that a full pass is
  // cheaper than carrying a timer, and it keeps the map from growing without bound.
  for (const [key, entry] of sessions) {
    if (Date.now() - entry.createdAt > SESSION_TTL_MS) sessions.delete(key);
  }
}

export function getStoredSession(sessionId: string | undefined): Session | undefined {
  if (!sessionId) return undefined;
  const entry = sessions.get(sessionId);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > SESSION_TTL_MS) {
    sessions.delete(sessionId);
    return undefined;
  }
  return entry.session;
}

export function deleteSession(sessionId: string | undefined): void {
  if (sessionId) sessions.delete(sessionId);
}

export function storePendingLogin(state: string, codeVerifier: string): void {
  pendingLogins.set(state, { codeVerifier, createdAt: Date.now() });
  for (const [key, value] of pendingLogins) {
    if (Date.now() - value.createdAt > PENDING_LOGIN_TTL_MS) pendingLogins.delete(key);
  }
}

export function consumePendingLogin(state: string): string | undefined {
  const entry = pendingLogins.get(state);
  pendingLogins.delete(state);
  if (!entry || Date.now() - entry.createdAt > PENDING_LOGIN_TTL_MS) return undefined;
  return entry.codeVerifier;
}
