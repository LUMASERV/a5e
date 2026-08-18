import { randomBytes, createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { readOidcConfigSecret } from '../lib/oidc-config-store';

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes: string;
  groupsClaim: string;
}

/** `redirectUri` is always derived from an origin + the fixed callback path — never stored — so
 * it can't drift from whatever the browser actually round-trips through. The callback route
 * (`/api/v1/auth/callback`) is served by the API itself, so this must be the API's OWN public
 * origin — not the UI's — whenever they're deployed on separate domains (see charts/a5e's
 * separate ui.ingress/api.ingress). `API_ORIGIN` falls back to `UI_ORIGIN` for the common
 * single-domain setup where the UI's own reverse proxy forwards `/api` to this service, so
 * existing deployments don't need a new env var to keep working. */
export function callbackRedirectUri(): string | undefined {
  const origin = process.env.API_ORIGIN ?? process.env.UI_ORIGIN;
  return origin ? `${origin.replace(/\/$/, '')}/api/v1/auth/callback` : undefined;
}

/**
 * Runtime-editable config (Settings page, backed by a Secret — see lib/oidc-config-store.ts)
 * takes priority over env vars, which now serve only as an optional bootstrap default for a
 * fresh install with no Secret yet.
 */
export async function resolveOidcConfig(): Promise<OidcConfig | undefined> {
  const stored = await readOidcConfigSecret().catch(() => undefined);
  const issuer = stored?.issuer || process.env.OIDC_ISSUER;
  const clientId = stored?.clientId || process.env.OIDC_CLIENT_ID;
  const redirectUri = callbackRedirectUri();
  if (!issuer || !clientId || !redirectUri) return undefined;
  return {
    issuer,
    clientId,
    clientSecret: stored?.clientSecret || process.env.OIDC_CLIENT_SECRET,
    redirectUri,
    // "groups" (and even "email") are NOT guaranteed-standard OIDC scopes the way "openid"/
    // "profile" are — an IdP has to define them explicitly (e.g. a Keycloak client scope)
    // before requesting one is even legal; asking for it unconditionally makes login fail
    // outright (`invalid_scope`) against any client that hasn't set that up. Default to the
    // narrow, universally-safe baseline. Two features need scopes widened beyond it:
    // group-based RBAC needs "groups" (or whatever the IdP calls it, via OIDC_GROUPS_CLAIM if
    // not literally "groups" in the token) requested and present as a claim; local-account
    // linking by email (auth/local-accounts.ts) needs "email" requested so the token actually
    // carries an email claim to match against.
    scopes: stored?.scopes || process.env.OIDC_SCOPES || 'openid profile',
    groupsClaim: process.env.OIDC_GROUPS_CLAIM ?? 'groups',
  };
}

interface DiscoveryDoc {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

// Keyed by issuer, not a single value: the issuer is now editable at runtime (Settings page),
// so a fixed module-level cache would keep serving a stale discovery doc/JWKS from whatever
// issuer was configured first, forever, after an admin points this at a different IdP.
const discoveryCache = new Map<string, DiscoveryDoc>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

async function discover(config: OidcConfig): Promise<DiscoveryDoc> {
  const cached = discoveryCache.get(config.issuer);
  if (cached) return cached;
  const res = await fetch(`${config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  const doc = (await res.json()) as DiscoveryDoc;
  discoveryCache.set(config.issuer, doc);
  return doc;
}

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function generateState(): string {
  return base64url(randomBytes(16));
}

export async function buildAuthorizationUrl(
  config: OidcConfig,
  state: string,
  codeChallenge: string,
): Promise<string> {
  const doc = await discover(config);
  const url = new URL(doc.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scopes);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export interface TokenResponse {
  id_token: string;
  access_token?: string;
}

export async function exchangeCodeForTokens(
  config: OidcConfig,
  code: string,
  codeVerifier: string,
): Promise<TokenResponse> {
  const doc = await discover(config);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    code_verifier: codeVerifier,
  });
  if (config.clientSecret) body.set('client_secret', config.clientSecret);

  const res = await fetch(doc.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as TokenResponse;
}

export interface VerifiedIdentity {
  /** The token's `sub` claim — stable and unique per-issuer, unlike email (can change, be
   * reused, or be absent depending on requested scopes), so this is always the primary
   * impersonation identity, not just a fallback. */
  sub: string;
  /** Only for display and for local-account linking-by-email (auth/local-accounts.ts) — never
   * used as the impersonation identity itself. Only present if the "email" scope was requested. */
  email?: string;
  /** True only if the IdP itself asserts `email_verified: true` on the token — linking-by-email
   * (auth/local-accounts.ts) must never trust an unverified `email` claim, since some IdPs let a
   * user set an arbitrary/unverified email on their own profile, which would otherwise let an
   * attacker link to (and inherit the role/groups of) any local account by guessing its email. */
  emailVerified: boolean;
  groups: string[];
  claims: Record<string, unknown>;
}

export async function verifyIdToken(config: OidcConfig, idToken: string): Promise<VerifiedIdentity> {
  const doc = await discover(config);
  let jwks = jwksCache.get(config.issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(doc.jwks_uri));
    jwksCache.set(config.issuer, jwks);
  }
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: config.issuer,
    audience: config.clientId,
  });

  const groupsClaim = payload[config.groupsClaim];
  const groups = Array.isArray(groupsClaim) ? groupsClaim.map(String) : [];

  return {
    sub: payload.sub as string,
    email: payload.email as string | undefined,
    emailVerified: payload.email_verified === true,
    groups,
    claims: payload as Record<string, unknown>,
  };
}

export async function endSessionUrl(config: OidcConfig): Promise<string | undefined> {
  const doc = await discover(config);
  return doc.end_session_endpoint;
}
