import { randomBytes } from 'node:crypto';
import type { Session } from './session';

/**
 * In-memory session + PKCE-state store. Fine for a single API replica (today's deployment
 * shape); a horizontally-scaled API would need this backed by something shared (e.g. a Secret
 * or an external cache) instead — noted here as a follow-up, not solved now.
 */
const sessions = new Map<string, Session>();

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
  sessions.set(sessionId, session);
}

export function getStoredSession(sessionId: string | undefined): Session | undefined {
  if (!sessionId) return undefined;
  return sessions.get(sessionId);
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
