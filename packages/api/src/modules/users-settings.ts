import { createLocalAccount } from '../auth/local-accounts';
import { APP_ROLES, type AppRole } from '../auth/roles';
import { deleteUser, listUsers, setUserRole } from '../auth/users';
import { authorize } from '../auth/authorize';
import { extractBearerToken } from '../auth/session';
import type { AnyElysia } from '../lib/elysia-types';

function isAppRole(value: unknown): value is AppRole {
  return typeof value === 'string' && (APP_ROLES as readonly string[]).includes(value);
}

/**
 * Manage every identity that can log in — local username/password accounts and OIDC identities
 * that have logged in at least once (see auth/users.ts, which merges the two: a local account
 * linked to an OIDC sub by email shows as one row). Requires "admin" (see auth/roles.ts): this
 * grants/revokes app access and k8s impersonation groups for any account.
 */
export function registerUsersSettingsRoutes(app: AnyElysia): AnyElysia {
  return app
    .get('/api/v1/config/users', async ({ headers }) => {
      const auth = await authorize(extractBearerToken(headers), 'admin');
      if (auth instanceof Response) return auth;
      return { items: await listUsers() };
    })

    .post('/api/v1/config/users', async ({ headers, body, set }) => {
      const auth = await authorize(extractBearerToken(headers), 'admin');
      if (auth instanceof Response) return auth;

      const b = body as {
        username?: string;
        password?: string;
        email?: string;
        displayName?: string;
        impersonateGroups?: string[];
        role?: string;
      };
      if (!b.username?.trim() || !b.password) {
        set.status = 400;
        return { error: 'username and password are required' };
      }
      const role = isAppRole(b.role) ? b.role : 'none';

      try {
        await createLocalAccount({
          username: b.username.trim(),
          password: b.password,
          email: b.email?.trim() || undefined,
          displayName: b.displayName?.trim() || undefined,
          impersonateGroups: b.impersonateGroups ?? [],
          role,
        });
        set.status = 201;
        return { ok: true };
      } catch (err) {
        set.status = 409;
        return { error: (err as Error).message };
      }
    })

    .patch('/api/v1/config/users/:id', async ({ headers, params, body, set }) => {
      const auth = await authorize(extractBearerToken(headers), 'admin');
      if (auth instanceof Response) return auth;

      const b = body as { role?: string };
      if (!isAppRole(b.role)) {
        set.status = 400;
        return { error: `role must be one of: ${APP_ROLES.join(', ')}` };
      }
      await setUserRole(decodeURIComponent(params.id), b.role);
      return { ok: true };
    })

    .delete('/api/v1/config/users/:id', async ({ headers, params, set }) => {
      const auth = await authorize(extractBearerToken(headers), 'admin');
      if (auth instanceof Response) return auth;
      await deleteUser(decodeURIComponent(params.id));
      set.status = 204;
    });
}
