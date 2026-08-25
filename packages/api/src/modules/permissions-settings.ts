import { permissionSchema } from '@a5e/schemas';
import { authorize } from '../auth/authorize';
import { deleteGroup, listGroups, upsertGroup } from '../auth/groups';
import { resolveEffectivePermissions } from '../auth/permission-engine';
import { extractBearerToken } from '../auth/session';
import type { AnyElysia } from '../lib/elysia-types';

const permissionsPatchSchema = permissionSchema.array();

/**
 * Admin-only CRUD for the first-class `Group` object (see auth/groups.ts) that a local user's
 * `impersonateGroups`/an OIDC group claim can reference by name, plus a self-service endpoint any
 * logged-in user can call to see their own effective grants.
 */
export function registerPermissionsSettingsRoutes(app: AnyElysia): AnyElysia {
  return app
    .get('/api/v1/config/groups', async ({ headers }) => {
      const auth = await authorize(extractBearerToken(headers), 'admin');
      if (auth instanceof Response) return auth;
      return { items: await listGroups() };
    })

    .put('/api/v1/config/groups/:name', async ({ headers, params, body, set }) => {
      const auth = await authorize(extractBearerToken(headers), 'admin');
      if (auth instanceof Response) return auth;

      const name = decodeURIComponent(params.name);
      const permissionsInput = (body as { permissions?: unknown })?.permissions ?? [];
      const parsed = permissionsPatchSchema.safeParse(permissionsInput);
      if (!parsed.success) {
        set.status = 400;
        return { error: `invalid permissions: ${parsed.error.message}` };
      }
      await upsertGroup(name, parsed.data);
      return { ok: true };
    })

    .delete('/api/v1/config/groups/:name', async ({ headers, params, set }) => {
      const auth = await authorize(extractBearerToken(headers), 'admin');
      if (auth instanceof Response) return auth;
      await deleteGroup(decodeURIComponent(params.name));
      set.status = 204;
    })

    .get('/api/v1/me/permissions', async ({ headers }) => {
      const auth = await authorize(extractBearerToken(headers), 'user');
      if (auth instanceof Response) return auth;
      return {
        role: auth.role,
        permissions: await resolveEffectivePermissions(auth.session, auth.role),
      };
    });
}
