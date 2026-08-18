import { callbackRedirectUri } from '../auth/oidc';
import { readOidcConfigSecret, writeOidcConfigSecret } from '../lib/oidc-config-store';
import { authorize } from '../auth/authorize';
import { extractBearerToken } from '../auth/session';
import type { AnyElysia } from '../lib/elysia-types';

/**
 * Lets Settings show/edit the OIDC client config without a redeploy (see lib/oidc-config-store.ts
 * for why this lives in a Secret rather than only env vars). `clientSecret` is write-only — GET
 * never echoes it back, only whether one is currently set — so the browser never receives it.
 * Requires the "admin" app role (see auth/roles.ts) — this can repoint login at a different IdP
 * entirely, so it's not something a plain "user" role should reach.
 */
export function registerOidcSettingsRoutes(app: AnyElysia): AnyElysia {
  return app
    .get('/api/v1/config/oidc', async ({ headers }) => {
      const auth = await authorize(extractBearerToken(headers), 'admin');
      if (auth instanceof Response) return auth;

      const stored = await readOidcConfigSecret().catch(() => undefined);
      const issuer = stored?.issuer || process.env.OIDC_ISSUER || '';
      const clientId = stored?.clientId || process.env.OIDC_CLIENT_ID || '';
      const hasClientSecret = Boolean(stored?.clientSecret || process.env.OIDC_CLIENT_SECRET);
      const scopes = stored?.scopes || process.env.OIDC_SCOPES || 'openid profile';
      const redirectUri = callbackRedirectUri() ?? '';

      return {
        issuer,
        clientId,
        hasClientSecret,
        scopes,
        redirectUri,
        configured: Boolean(issuer && clientId && redirectUri),
      };
    })

    .put('/api/v1/config/oidc', async ({ headers, body, set }) => {
      const auth = await authorize(extractBearerToken(headers), 'admin');
      if (auth instanceof Response) return auth;

      const b = body as { issuer?: string; clientId?: string; clientSecret?: string; scopes?: string };
      if (!b.issuer?.trim() || !b.clientId?.trim()) {
        set.status = 400;
        return { error: 'issuer and clientId are required' };
      }

      await writeOidcConfigSecret({
        issuer: b.issuer.trim(),
        clientId: b.clientId.trim(),
        clientSecret: b.clientSecret?.trim(),
        scopes: b.scopes?.trim(),
      });
      return { ok: true };
    });
}
