import type { CallerIdentity } from '@a5e/k8s-client';
import { getStoredSession } from './session-store';

/** A browser session's identity is always the impersonated-user shape — 'self' (the API's own
 * ServiceAccount identity, used internally for app-config Secrets) never applies to a logged-in
 * user, so it's excluded here rather than forcing every consumer to narrow it. */
export type SessionIdentity = Exclude<CallerIdentity, 'self'>;

export interface Session {
  identity: SessionIdentity;
  displayName: string;
  /** Explicit discriminant for which app-level identity store (auth/local-accounts.ts vs
   * auth/roles.ts's OIDC-user-roles map) governs this session's role — set once at login time,
   * never inferred from `identity.impersonateUser`'s string shape. That string is also the literal
   * Kubernetes `Impersonate-User` value cluster admins bind real RBAC to (`local:<username>` or
   * the raw OIDC `sub`), so it can't double as a trust boundary: a maliciously-configured IdP
   * could otherwise issue a `sub` like `local:admin` and get treated as the local admin account
   * by a naive `startsWith('local:')` check. */
  kind: 'local' | 'oidc';
}

/** Resolves the bearer token issued by the OIDC callback or local-login route (auth/routes.ts)
 * against the in-memory session store. There's no dev-mode bypass — see auth/bootstrap.ts for
 * how a fresh install gets its first real login instead. */
export function resolveSession(token: unknown): Session | null {
  const sessionId = typeof token === 'string' ? token : undefined;
  return getStoredSession(sessionId) ?? null;
}

/** Extracts the bearer token from an `Authorization: Bearer <token>` header. The API is
 * cookie-free by design — the UI and API are meant to run on independent origins/domains (see
 * charts/a5e's separate ui.ingress/api.ingress), and a cookie-based session would either need
 * SameSite=None (which, combined with credentials, reopens CSRF unless every mutating route also
 * validates Origin) or be restricted to same-site subdomain deployments only. A bearer token in
 * an explicit header sidesteps both: it's never sent automatically by the browser, so a
 * cross-origin page can't trigger authenticated requests just by getting a victim to load it —
 * the token has to be deliberately attached by this app's own JS. */
export function extractBearerToken(
  headers: Record<string, string | undefined>,
): string | undefined {
  const value = headers.authorization ?? headers.Authorization;
  if (!value?.startsWith('Bearer ')) return undefined;
  return value.slice('Bearer '.length).trim() || undefined;
}
