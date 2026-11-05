import { API_GROUP_VERSION, RESOURCE_DESCRIPTORS_BY_KIND, changeItemSchema } from '@a5e/schemas';
import type {
  ChangeItem,
  ChangeRequestSpec,
  ChangeRequestStatus,
  CustomResource,
  Permission,
} from '@a5e/schemas';
import { authorize } from '../auth/authorize';
import type { ActionTarget } from '../auth/permission-engine';
import {
  canAct,
  mergedLabelsAfterPatch,
  resolveEffectivePermissions,
} from '../auth/permission-engine';
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

type ItemLabels = Record<string, string> | undefined;

function bodyLabelsOf(item: ChangeItem): ItemLabels {
  return (item.body as { metadata?: { labels?: ItemLabels } })?.metadata?.labels;
}

/**
 * The namespace an item is authorized against. Derived from the kind's own descriptor, NEVER from
 * `item.namespace` — the schema accepts a namespace on any item, but the k8s client ignores it for
 * a cluster-scoped kind. Trusting it let a staged `ClusterAnsibleHost` delete carry
 * `namespace: 'team-a'`, satisfy a team-a-only approve grant, and then delete the cluster-wide
 * object (the same bypass namespaceMatches was tightened to prevent).
 */
export function authNamespace(item: ChangeItem): string | undefined {
  return RESOURCE_DESCRIPTORS_BY_KIND[item.type]?.scope === 'Namespaced'
    ? item.namespace
    : undefined;
}

/** Identifies the object an item acts on, so repeated items on one object can be chained below. */
function targetKey(item: ChangeItem): string {
  return `${item.type}/${authNamespace(item) ?? ''}/${item.name ?? ''}`;
}

/**
 * The approve/decline permission targets for every staged item, in order.
 *
 * Labels come from the object as it exists in the cluster, never from `item.body` — that body is
 * whatever the *requester* typed. Trusting it meant a requester could stage an update to a
 * production object while writing `labels: {env: dev}` into the body, and an approver whose grant
 * only covers `env=dev` would see a dev-looking item, approve it, and the patch would land on the
 * production object. A `delete` item carries no body at all, so every label-restricted grant was
 * being evaluated against no labels (and a `NotIn`-style grant matched everything, prod included).
 *
 * An `update` is checked on both sides — before and after its patch — the same rule the plain
 * PATCH route applies (see modules/resource-routes.ts), so approving can't relabel an object out
 * of the approver's own scope.
 *
 * Items are walked in apply order with the labels they project carried forward, because the apply
 * loop applies them in that same order. Checking each one against the *live* labels instead let
 * two patches on one object jointly escape every grant while passing individually: with grants for
 * `env=dev` or `team=a` on `{env: dev, team: a}`, a patch to `env=prod` and a patch to `team=b`
 * each look fine against the starting labels, but applied in sequence they leave `{env: prod,
 * team: b}`, which matches neither. The UI stages one item per edit and does not merge repeated
 * edits of the same object (see ui/src/stores/changeRequestDraft.ts's `addItem`), so this is an
 * ordinary draft, not only a hand-crafted request.
 */
export async function approvalTargets(changes: ChangeItem[]): Promise<ActionTarget[][]> {
  const perItem: ActionTarget[][] = [];
  const projected = new Map<string, ItemLabels>();

  for (const item of changes) {
    const base = { type: item.type, namespace: authNamespace(item) };
    const key = targetKey(item);
    const targets: ActionTarget[] = [];
    perItem.push(targets);

    if (item.action === 'create') {
      const labels = bodyLabelsOf(item);
      targets.push({ ...base, labels });
      projected.set(key, labels);
      continue;
    }

    let before: ItemLabels;
    if (projected.has(key)) {
      before = projected.get(key);
    } else {
      const itemDescriptor = RESOURCE_DESCRIPTORS_BY_KIND[item.type];
      // Unknown kind, or the object is already gone: there is no live object to authorize
      // against, and applying the item can only 404 — harmless. Contribute no target rather than
      // denying, so a stale request can still be declined (declining executes nothing). Any other
      // lookup failure propagates and is treated as a denial by the caller.
      if (!itemDescriptor) continue;
      const current = await client
        .get<{ metadata: { labels?: Record<string, string> } }>(
          itemDescriptor,
          item.name!,
          'self',
          authNamespace(item),
        )
        .catch((err) => {
          if ((err as { code?: number }).code === 404) return undefined;
          throw err;
        });
      if (!current) continue;
      before = current.metadata.labels;
    }

    targets.push({ ...base, labels: before });
    if (item.action === 'delete') {
      projected.delete(key);
      continue;
    }
    const after = mergedLabelsAfterPatch(before, item.body);
    targets.push({ ...base, labels: after });
    projected.set(key, after);
  }

  return perItem;
}

/**
 * Indices of the staged items the caller may NOT approve, or `'error'` if the targets couldn't be
 * resolved at all — any lookup failure other than "the object is gone" denies the whole request,
 * so this fails closed.
 */
async function deniedItemIndices(
  perms: Permission[],
  changes: ChangeItem[],
): Promise<number[] | 'error'> {
  let perItem: ActionTarget[][];
  try {
    perItem = await approvalTargets(changes);
  } catch {
    return 'error';
  }
  return perItem.flatMap((targets, index) =>
    targets.every((target) => canAct(perms, target, 'approve')) ? [] : [index],
  );
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
      const denied = await deniedItemIndices(perms, cr.spec.changes);
      if (denied === 'error') {
        set.status = 403;
        return { error: 'could not verify the staged objects — approval denied' };
      }
      if (denied.length > 0) {
        set.status = 403;
        return { error: 'forbidden', deniedItems: denied };
      }

      const reviewed = {
        reviewedBy: appUserId(auth.session),
        reviewedByName: auth.session.displayName,
        reviewedAt: new Date().toISOString(),
      };

      // Claim the request before applying anything. `replaceStatus` carries the resourceVersion we
      // read above, so of two approvers racing (or one double-click) exactly one write lands and
      // the other gets a 409 — without this both passed the `phase !== 'Pending'` check above and
      // both ran the loop below, applying every change twice and recording the second pass's
      // 409s/404s as `Failed` even though everything had actually been applied.
      try {
        await client.replaceStatus(
          descriptor,
          params.name,
          { ...cr, status: { ...cr.status, ...reviewed, phase: 'Approved' } },
          'self',
        );
      } catch (err) {
        if ((err as { code?: number }).code === 409) {
          set.status = 409;
          return { error: 'already being reviewed by someone else' };
        }
        throw err;
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
      await client.patchStatus(descriptor, params.name, { phase, ...reviewed, results }, 'self');
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
      const denied = await deniedItemIndices(perms, cr.spec.changes);
      if (denied === 'error' || denied.length > 0) {
        set.status = 403;
        return { error: 'forbidden' };
      }

      // replaceStatus rather than patchStatus: declining is a single write, so carrying the
      // resourceVersion read above is enough to lose cleanly against an approver who got there
      // first, instead of overwriting their verdict.
      try {
        await client.replaceStatus(
          descriptor,
          params.name,
          {
            ...cr,
            status: {
              ...cr.status,
              phase: 'Declined',
              reviewedBy: appUserId(auth.session),
              reviewedByName: auth.session.displayName,
              reviewedAt: new Date().toISOString(),
              declineReason: (body as { reason?: string })?.reason,
            },
          },
          'self',
        );
      } catch (err) {
        if ((err as { code?: number }).code === 409) {
          set.status = 409;
          return { error: 'already being reviewed by someone else' };
        }
        throw err;
      }
      return { ok: true };
    });
}
