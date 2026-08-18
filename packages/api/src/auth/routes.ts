import type { AnyElysia } from '../lib/elysia-types';
import {
  buildAuthorizationUrl,
  endSessionUrl,
  exchangeCodeForTokens,
  generatePkce,
  generateState,
  resolveOidcConfig,
  verifyIdToken,
} from './oidc';
import { findAccountBySub, linkAccountToSub, verifyLocalLogin } from './local-accounts';
import { trackOidcLogin } from './roles';
import { consumePendingLogin, createSessionId, deleteSession, storePendingLogin, storeSession } from './session-store';
import { extractBearerToken } from './session';
import type { Session } from './session';

/** local-account identities are prefixed to keep them visually/structurally distinct from OIDC
 * `sub` values in RBAC bindings and audit logs — never collides with a real issuer's sub format. */
function localIdentity(username: string, impersonateGroups: string[]): Session['identity'] {
  return { impersonateUser: `local:${username}`, impersonateGroups };
}

function uiOrigin(): string {
  return process.env.UI_ORIGIN ?? 'http://localhost:5173';
}

/** `/login`/`/callback` are navigated to directly by the browser (a link click, or the IdP's own
 * redirect) — never fetched via the SPA's API client — so an error response has to be a redirect
 * back into the app, not a raw JSON body the browser would otherwise render as a bare page. */
function redirectToLoginWithError(redirect: (url: string, status: number) => unknown, message: string) {
  const url = new URL('/login', uiOrigin());
  url.searchParams.set('error', message);
  return redirect(url.toString(), 302);
}

// Binds the OAuth `state` to the browser that started the flow — RFC 6749 §10.12's CSRF
// protection requires this; a `state` that's merely unguessable but not tied to the initiating
// user-agent still lets an attacker start their own login, capture the resulting callback URL,
// and hand it to a victim, whose browser would otherwise happily complete the attacker's login
// and end up with a session under the attacker's identity ("login CSRF" / session swapping). This
// is the one cookie the API still sets — it's a same-origin round trip entirely within /login →
// /callback on the API's own domain, regardless of what domain the UI lives on, so it's unrelated
// to the UI/API cross-origin session model below.
const OIDC_STATE_COOKIE = 'oidc_state';
const isProd = process.env.NODE_ENV === 'production';

/**
 * OIDC Authorization Code + PKCE, terminated at the API (Backend-for-Frontend pattern) — the UI
 * never talks to the IdP directly. Session auth is a bearer token, not a cookie: the UI and API
 * are meant to be deployable on independent origins (see charts/a5e's separate ui.ingress/
 * api.ingress), and a cross-origin session cookie would need SameSite=None (safe only alongside
 * Origin-header validation on every mutating route, since SameSite is what currently provides
 * CSRF protection) or be restricted to same-site subdomain deployments. A bearer token sidesteps
 * this: it's never attached by the browser automatically, only by this app's own JS explicitly
 * setting the Authorization header, so a third-party page can't trigger authenticated requests
 * just by getting a victim to load it. Authorization itself is still real Kubernetes RBAC via
 * impersonation (CustomResourceClient/k8s-client), not app code — this module's only job is
 * turning "who is this" into a `{impersonateUser, impersonateGroups}` identity, once, at login
 * time, and handing back an opaque token the UI stores and replays as `Authorization: Bearer`.
 */
export function registerAuthRoutes(app: AnyElysia): AnyElysia {
  return app
    .get('/api/v1/auth/oidc-status', async () => ({ configured: Boolean(await resolveOidcConfig()) }))

    .get('/api/v1/auth/login', async ({ cookie, redirect }) => {
      const config = await resolveOidcConfig();
      if (!config) {
        return redirectToLoginWithError(redirect, 'OIDC is not configured — set it up in Settings, or ask an admin to.');
      }

      const state = generateState();
      const { verifier, challenge } = generatePkce();
      storePendingLogin(state, verifier);

      cookie[OIDC_STATE_COOKIE]?.set({
        value: state,
        httpOnly: true,
        secure: isProd,
        sameSite: 'lax',
        path: '/api/v1/auth',
        maxAge: 5 * 60,
      });

      const url = await buildAuthorizationUrl(config, state, challenge);
      return redirect(url, 302);
    })

    .get('/api/v1/auth/callback', async ({ query, cookie, redirect }) => {
      const config = await resolveOidcConfig();
      if (!config) {
        return redirectToLoginWithError(redirect, 'OIDC is not configured');
      }

      const code = query.code;
      const state = query.state;
      if (!code || !state) {
        return redirectToLoginWithError(redirect, 'Login failed: missing code/state from the identity provider.');
      }

      // Requires the state to match a cookie set on THIS browser at /login time — a state that's
      // merely unguessable but not bound to the initiating user-agent is still vulnerable to an
      // attacker starting their own login, capturing the callback URL, and handing it to a victim
      // (see OIDC_STATE_COOKIE's definition above).
      const stateCookie = cookie[OIDC_STATE_COOKIE]?.value;
      cookie[OIDC_STATE_COOKIE]?.remove();
      if (!stateCookie || stateCookie !== state) {
        return redirectToLoginWithError(redirect, 'Login state does not match this browser — please try signing in again.');
      }

      const codeVerifier = consumePendingLogin(state);
      if (!codeVerifier) {
        return redirectToLoginWithError(redirect, 'Login link expired — please try signing in again.');
      }

      try {
        const tokens = await exchangeCodeForTokens(config, code, codeVerifier);
        const verified = await verifyIdToken(config, tokens.id_token);

        // A local account already linked to this sub (from a prior login) always wins — it's
        // the whole point of linking: one RBAC identity regardless of which login method was
        // used this time. Otherwise, try a fresh link by matching email (no-op if no local
        // account has that email, or if "email" wasn't requested as a scope at all).
        const linked = (await findAccountBySub(verified.sub)) ?? (await linkAccountToSub(verified.email, verified.emailVerified, verified.sub));

        let session: Session;
        if (linked) {
          session = {
            identity: localIdentity(linked.username, linked.impersonateGroups),
            displayName: linked.displayName ?? linked.email ?? linked.username,
            kind: 'local',
          };
        } else {
          const displayName = verified.email ?? verified.sub;
          // Not linked to any local account — track this sub in the standalone OIDC-user role
          // registry (see auth/roles.ts) so it shows up for an admin to promote from the default
          // `role: none`. Keeps email/displayName fresh on every login without ever touching an
          // already-assigned role.
          await trackOidcLogin(verified.sub, verified.email, displayName);
          session = { identity: { impersonateUser: verified.sub, impersonateGroups: verified.groups }, displayName, kind: 'oidc' };
        }

        const sessionId = createSessionId();
        storeSession(sessionId, session);

        // The token travels in the URL *fragment*, never a query string: fragments are stripped
        // by the browser before the request line is even built, so they never reach this (or any)
        // server's access logs, Referer headers, or a proxy in between — only client-side JS on
        // the receiving page can read `location.hash`. The UI's /auth/callback route (a public,
        // unauthenticated route) is exactly that JS: it reads the token, stores it, then
        // immediately replaces the URL so the token doesn't linger in browser history either.
        const callbackUrl = new URL('/auth/callback', uiOrigin());
        callbackUrl.hash = `token=${encodeURIComponent(sessionId)}`;
        return redirect(callbackUrl.toString(), 302);
      } catch (err) {
        return redirectToLoginWithError(redirect, `Login failed: ${(err as Error).message}`);
      }
    })

    .post('/api/v1/auth/local-login', async ({ body, set }) => {
      const { username, password } = body as { username?: string; password?: string };
      if (!username || !password) {
        set.status = 400;
        return { error: 'username and password are required' };
      }

      const account = await verifyLocalLogin(username, password);
      if (!account) {
        set.status = 401;
        return { error: 'invalid username or password' };
      }

      const sessionId = createSessionId();
      storeSession(sessionId, {
        identity: localIdentity(account.username, account.impersonateGroups),
        displayName: account.displayName ?? account.username,
        kind: 'local',
      });

      return { token: sessionId };
    })

    .post('/api/v1/auth/logout', async ({ headers }) => {
      deleteSession(extractBearerToken(headers));

      const config = await resolveOidcConfig();
      if (config) {
        const endSession = await endSessionUrl(config).catch(() => undefined);
        if (endSession) return { endSessionUrl: endSession };
      }
      return { ok: true };
    });
}
