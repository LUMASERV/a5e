import { API_GROUP_VERSION, RESOURCE_DESCRIPTORS_BY_KIND, changeItemSchema } from '@a5e/schemas';
import type {
  ChangeItem,
  ChangeRequestSpec,
  ChangeRequestStatus,
  CustomResource,
} from '@a5e/schemas';
import { authorize } from '../auth/authorize';
import { canAct, resolveEffectivePermissions } from '../auth/permission-engine';
import { extractBearerToken } from '../auth/session';
import type { Session } from '../auth/session';
import { readAppSettings } from '../lib/app-settings-store';
import type { AnyElysia } from '../lib/elysia-types';
import { client } from '../plugins/k8s';
import { registerResourceRoutes } from './resource-routes';

const descriptor = RESOURCE_DESCRIPTORS_BY_KIND.ChangeRequest!;
type ChangeRequest = CustomResource<ChangeRequestSpec, ChangeRequestStatus>;

/** `local:<username>` or `oidc:<sub>` — matches auth/users.ts's `AppUser.id` scheme, deliberately
 * NOT the raw `session.identity.impersonateUser` (see users.ts's doc comment on why prefixing
 * matters: an attacker-supplied OIDC `sub` could otherwise collide with a local account's id). */
function appUserId(session: Session): string {
  return session.kind === 'local'
    ? session.identity.impersonateUser
    : `oidc:${session.identity.impersonateUser}`;
}

function itemTarget(item: ChangeItem) {
  return {
    type: item.type,
    namespace: item.namespace,
    labels: (item.body as { metadata?: { labels?: Record<string, string> } })?.metadata?.labels,
  };
}

/**
 * ChangeRequest reuses the generic factory for list/get/watch (see modules/resource-routes.ts) —
 * ordinary, permission-gated reads — but needs bespoke create/delete/approve/decline: create must
 * stamp trusted `requestedBy`/`requestedAt` server-side and is deliberately ungated (any logged-in
 * user can propose, per the "team can add hosts while admins keep control" decision); delete is a
 * self-withdraw or an admin/approver action; approve/decline apply the staged changes for real,
 * gated per-item against the approver's own `approve` grant.
 */
export function registerChangeRequestRoutes(initialApp: AnyElysia): AnyElysia {
  const app = registerResourceRoutes(initialApp, descriptor, { skipRoutes: ['create', 'delete'] });

  return app
    .post('/api/v1/changerequests', async ({ headers, body, set }) => {
      const auth = await authorize(extractBearerToken(headers), 'user');
      if (auth instanceof Response) return auth;

      // Gate creation only — an admin toggling this off shouldn't strand ChangeRequests already
      // in flight, so list/get/watch/approve/decline/withdraw stay reachable regardless. This is
      // the real enforcement point; the UI additionally hides its own entry points (nav item,
      // header button, "stage on denied" upsell) as a courtesy, not as the source of truth.
      const settings = await readAppSettings();
      if (!settings.changeRequestsEnabled) {
        set.status = 403;
        return { error: 'the change request flow is disabled for this instance' };
      }

      const b = body as {
        metadata?: { name?: string; generateName?: string };
        spec?: { reason?: string; changes?: unknown };
      };
      const changesResult = changeItemSchema.array().min(1).safeParse(b.spec?.changes);
      if (!changesResult.success) {
        set.status = 400;
        return { error: `invalid changes: ${changesResult.error.message}` };
      }
      for (const item of changesResult.data) {
        if (!RESOURCE_DESCRIPTORS_BY_KIND[item.type]) {
          set.status = 400;
          return { error: `unknown resource type "${item.type}"` };
        }
        if ((item.action === 'update' || item.action === 'delete') && !item.name) {
          set.status = 400;
          return { error: `"name" is required for a ${item.action} item` };
        }
        if ((item.action === 'create' || item.action === 'update') && item.body === undefined) {
          set.status = 400;
          return { error: `"body" is required for a ${item.action} item` };
        }
      }

      set.status = 201;
      return client.create<ChangeRequest>(
        descriptor,
        {
          apiVersion: API_GROUP_VERSION,
          kind: 'ChangeRequest',
          metadata: b.metadata?.name
            ? { name: b.metadata.name }
            : { generateName: b.metadata?.generateName ?? 'cr-' },
          spec: {
            requestedBy: appUserId(auth.session),
            requestedByName: auth.session.displayName,
            requestedAt: new Date().toISOString(),
            reason: b.spec?.reason,
            changes: changesResult.data,
          },
        },
        'self',
      );
    })

    .delete('/api/v1/changerequests/:name', async ({ params, headers, set }) => {
      const auth = await authorize(extractBearerToken(headers), 'user');
      if (auth instanceof Response) return auth;
      const cr = await client.get<ChangeRequest>(descriptor, params.name, 'self');

      const isOwnerWithdraw =
        cr.spec.requestedBy === appUserId(auth.session) &&
        cr.status?.phase !== 'Approved' &&
        cr.status?.phase !== 'Applied';
      if (!isOwnerWithdraw) {
        const perms = await resolveEffectivePermissions(auth.session, auth.role);
        if (!canAct(perms, { type: 'ChangeRequest' }, 'delete')) {
          set.status = 403;
          return { error: 'forbidden', type: 'ChangeRequest', action: 'delete' };
        }
      }
      await client.delete(descriptor, params.name, 'self');
      set.status = 204;
    })

    .post('/api/v1/changerequests/:name/approve', async ({ params, headers, set }) => {
      const auth = await authorize(extractBearerToken(headers), 'user');
      if (auth instanceof Response) return auth;
      const cr = await client.get<ChangeRequest>(descriptor, params.name, 'self');
      if (cr.status?.phase && cr.status.phase !== 'Pending') {
        set.status = 409;
        return { error: `already ${cr.status.phase}` };
      }

      const perms = await resolveEffectivePermissions(auth.session, auth.role);
      const denied = cr.spec.changes
        .map((item, index) => ({ index, item }))
        .filter(({ item }) => !canAct(perms, itemTarget(item), 'approve'));
      if (denied.length > 0) {
        set.status = 403;
        return { error: 'forbidden', deniedItems: denied.map((d) => d.index) };
      }

      const results: NonNullable<ChangeRequestStatus['results']> = [];
      let aborted = false;
      for (const [index, item] of cr.spec.changes.entries()) {
        if (aborted) {
          results.push({ index, status: 'Skipped' });
          continue;
        }
        try {
          const itemDescriptor = RESOURCE_DESCRIPTORS_BY_KIND[item.type];
          if (!itemDescriptor) throw new Error(`unknown resource type "${item.type}"`);
          if (item.action === 'create')
            await client.create(itemDescriptor, item.body, 'self', item.namespace);
          else if (item.action === 'update')
            // Merge-patch, not replace (PUT): a staged 'update' item's body can be either a full
            // object (from a form's save(), via store.update()) or a partial one (from an inline
            // mutation like the host list's "Enabled" toggle, via store.patch()) — the drafting
            // layer captures whatever was passed to either call under the same 'update' kind (see
            // createResourceStore.ts's MutationIntent). A PUT of a partial body either 400s (no
            // apiVersion/kind) or silently wipes every field the patch didn't mention; a
            // merge-patch is safe for both shapes, since it merges onto the object that already
            // exists rather than requiring the body to BE the whole object. Known limitation:
            // unlike a real replace, a merge-patch can't clear a field back to "unset" just by
            // omitting it — the field must be explicitly patched to `null` for that, which none of
            // today's staged edits do — accepted as strictly better than the alternative bug.
            await client.patch(itemDescriptor, item.name!, item.body, 'self', item.namespace);
          else await client.delete(itemDescriptor, item.name!, 'self', item.namespace);
          results.push({ index, status: 'Applied' });
        } catch (err) {
          results.push({ index, status: 'Failed', error: (err as Error).message });
          aborted = true;
        }
      }
      const phase = results.every((r) => r.status === 'Applied') ? 'Applied' : 'Failed';
      await client.patchStatus(
        descriptor,
        params.name,
        {
          phase,
          reviewedBy: appUserId(auth.session),
          reviewedByName: auth.session.displayName,
          reviewedAt: new Date().toISOString(),
          results,
        },
        'self',
      );
      return { ok: true, phase, results };
    })

    .post('/api/v1/changerequests/:name/decline', async ({ params, headers, body, set }) => {
      const auth = await authorize(extractBearerToken(headers), 'user');
      if (auth instanceof Response) return auth;
      const cr = await client.get<ChangeRequest>(descriptor, params.name, 'self');
      if (cr.status?.phase && cr.status.phase !== 'Pending') {
        set.status = 409;
        return { error: `already ${cr.status.phase}` };
      }

      const perms = await resolveEffectivePermissions(auth.session, auth.role);
      const denied = cr.spec.changes.some((item) => !canAct(perms, itemTarget(item), 'approve'));
      if (denied) {
        set.status = 403;
        return { error: 'forbidden' };
      }

      await client.patchStatus(
        descriptor,
        params.name,
        {
          phase: 'Declined',
          reviewedBy: appUserId(auth.session),
          reviewedByName: auth.session.displayName,
          reviewedAt: new Date().toISOString(),
          declineReason: (body as { reason?: string })?.reason,
        },
        'self',
      );
      return { ok: true };
    });
}
