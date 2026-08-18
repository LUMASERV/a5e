import { coreApi, impersonatedOptions } from '../plugins/k8s';
import { authorize } from '../auth/authorize';
import { resolveRole } from '../auth/roles';
import { extractBearerToken, resolveSession } from '../auth/session';
import type { AnyElysia } from '../lib/elysia-types';
import { resolveGlobalS3Config } from '../lib/s3-status';

function unauthorized() {
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });
}

export function registerAncillaryRoutes(app: AnyElysia): AnyElysia {
  return app
    .get('/healthz', () => ({ status: 'ok' }))
    .get('/readyz', () => ({ status: 'ok' }))

    // Deliberately just resolveSession, not authorize(): a role:'none' user still needs to see
    // their own identity/role (e.g. to render "ask an admin for access"), not a 403 on the one
    // call that would explain why everything else is 403ing.
    .get('/api/v1/whoami', async ({ headers }) => {
      const session = resolveSession(extractBearerToken(headers));
      if (!session) return unauthorized();
      const role = await resolveRole(session);
      return { displayName: session.displayName, identity: session.identity, role };
    })

    .get('/api/v1/namespaces', async ({ headers }) => {
      const auth = await authorize(extractBearerToken(headers), 'user');
      if (auth instanceof Response) return auth;
      const result = await coreApi.listNamespace(undefined, impersonatedOptions(auth.session.identity));
      return { items: result.items.map((ns) => ({ name: ns.metadata?.name })) };
    })

    .get('/api/v1/config/s3-status', async ({ headers }) => {
      const auth = await authorize(extractBearerToken(headers), 'admin');
      if (auth instanceof Response) return auth;
      return { configured: Boolean(resolveGlobalS3Config()) };
    });
}
