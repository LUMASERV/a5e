import { permissionSchema } from '@a5e/schemas';
import { authorize } from '../auth/authorize';
import { APP_ROLES, type AppRole } from '../auth/roles';
import { extractBearerToken } from '../auth/session';
import { createLocalAccount, deleteUser, listUsers, updateUser } from '../auth/user-store';
import type { UserUpdate } from '../auth/user-store';
import type { AnyElysia } from '../lib/elysia-types';

const permissionsPatchSchema = permissionSchema.array();

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
      if (!b.username?.trim()) {
        set.status = 400;
        return { error: 'username is required' };
      }
      // Password is optional (pre-provisioning a user ahead of their first SSO login — see
      // LocalAccount.passwordHash's doc comment), but the account needs SOME way to ever be
      // reached: without a password there must at least be an email for an SSO login to link to.
      if (!b.password && !b.email?.trim()) {
        set.status = 400;
        return { error: 'either a password or an email (for SSO account linking) is required' };
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

      const id = decodeURIComponent(params.id);
      const b = body as {
        username?: string;
        role?: string;
        email?: string;
        displayName?: string;
        impersonateGroups?: string[];
        password?: string;
        permissions?: unknown;
      };

      if (b.role !== undefined && !isAppRole(b.role)) {
        set.status = 400;
        return { error: `role must be one of: ${APP_ROLES.join(', ')}` };
      }
      let permissions: UserUpdate['permissions'];
      if (b.permissions !== undefined) {
        const parsed = permissionsPatchSchema.safeParse(b.permissions);
        if (!parsed.success) {
          set.status = 400;
          return { error: `invalid permissions: ${parsed.error.message}` };
        }
        permissions = parsed.data;
      }
      // An SSO-only row has no local account behind it, so only role/permissions are meaningful —
      // UNLESS `username` is also given, which promotes it into a real linked local account in
      // this same call (see auth/users.ts's updateUser), at which point every local-account field
      // becomes valid too. Reject rather than silently drop fields, so an admin editing what looks
      // like a normal row doesn't think an email/password/groups change took effect when it didn't.
      const hasNonRoleField =
        b.email !== undefined ||
        b.displayName !== undefined ||
        b.impersonateGroups !== undefined ||
        b.password !== undefined;
      if (id.startsWith('oidc:') && hasNonRoleField && !b.username?.trim()) {
        set.status = 400;
        return {
          error:
            'only role and permissions can be set for an SSO-only identity — provide a username to give it a local account first',
        };
      }

      const patch: UserUpdate = {
        username: b.username?.trim() || undefined,
        role: isAppRole(b.role) ? b.role : undefined,
        email: b.email?.trim(),
        displayName: b.displayName?.trim(),
        impersonateGroups: b.impersonateGroups,
        password: b.password || undefined,
        permissions,
      };
      try {
        await updateUser(id, patch);
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
      return { ok: true };
    })

    .delete('/api/v1/config/users/:id', async ({ headers, params, set }) => {
      const auth = await authorize(extractBearerToken(headers), 'admin');
      if (auth instanceof Response) return auth;
      await deleteUser(decodeURIComponent(params.id));
      set.status = 204;
    });
}
