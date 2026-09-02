import type { CustomResourceClient, ListOptions, ListResult } from '@a5e/k8s-client';
import { labelSelectorMatches, labelSelectorToString } from '@a5e/k8s-client';
import type { Permission, PermissionAction, ResourceDescriptor } from '@a5e/schemas';
import { listGroups } from './groups';
import type { AppRole } from './roles';
import { resolveRole } from './roles';
import type { Session } from './session';
import { findUserBySession } from './user-store';

function matchesType(p: Permission, type: string): boolean {
  return p.type === '*' || p.type === type;
}

function matchesAction(p: Permission, action: string): boolean {
  return p.actions.includes('*') || p.actions.includes(action as PermissionAction);
}

function namespaceMatches(p: Permission, namespace: string | undefined): boolean {
  if (p.namespaces.length === 0) return true;
  // Cluster-scoped kinds have no namespace — `namespaces` is meaningless for them, so an entry
  // there never excludes a cluster-scoped object.
  if (namespace === undefined) return true;
  return p.namespaces.includes(namespace);
}

/**
 * Merges a user's direct grants (`User.spec.permissions` — see auth/user-store.ts) with every
 * Group's grants matching an entry in `session.identity.impersonateGroups`, plus — for
 * `role === 'admin'` — a synthetic full-access wildcard computed fresh every call (never stored).
 * This is why an admin account keeps full access with zero data migration, and why an admin's own
 * `permissions` list (if ever populated) is simply moot while their role stays 'admin'.
 */
export async function resolveEffectivePermissions(
  session: Session,
  role?: AppRole,
): Promise<Permission[]> {
  const resolvedRole = role ?? (await resolveRole(session));

  const user = await findUserBySession(session);
  const direct = (user?.spec.permissions ?? []) as Permission[];

  const groupNames = session.identity.impersonateGroups ?? [];
  const groups = await listGroups();
  const fromGroups = groups
    .filter((g) => groupNames.includes(g.name))
    .flatMap((g) => g.permissions);

  const perms = [...direct, ...fromGroups];
  if (resolvedRole === 'admin') {
    perms.push({ type: '*', namespaces: [], actions: ['*'] });
  }
  return perms;
}

export function hasAction(perms: Permission[], type: string, action: PermissionAction): boolean {
  return perms.some((p) => matchesType(p, type) && matchesAction(p, action));
}

export interface ActionTarget {
  type: string;
  namespace?: string;
  labels?: Record<string, string>;
}

/** The per-object allow/deny decision — used by get/create/replace/patch/delete/approve. */
export function canAct(
  perms: Permission[],
  target: ActionTarget,
  action: PermissionAction,
): boolean {
  return perms.some(
    (p) =>
      matchesType(p, target.type) &&
      matchesAction(p, action) &&
      namespaceMatches(p, target.namespace) &&
      labelSelectorMatches(p.labelSelector, target.labels),
  );
}

/**
 * `canAct` without the label-selector check, for a target whose labels this app never reads.
 *
 * The only such target is the built-in `Secret` type (`use`, see auth/secret-use.ts): a5e does not
 * manage Secrets, it only dereferences one a host's `varsBySecretRef` names, and it may legitimately
 * be pointed at a Secret that does not exist yet — so there are no labels to match a selector
 * against. Routing that decision through `canAct` was a real bug: with no `labels` on the target,
 * `labelSelectorMatches` rejects every grant that carries a selector, so a broad
 * `{ type: '*', actions: ['*'], labelSelector: ... }` grant would authorize everything in the app
 * *except* using a Secret. A selector on such a grant scopes a5e's own labelled objects; it says
 * nothing about Secrets, so it must not silently deny here.
 *
 * `permissionSchema` additionally refuses a `labelSelector` on a `Secret`-typed grant outright
 * (see @a5e/schemas' permissions.ts), so ignoring one here can never quietly widen a grant somebody
 * wrote intending to narrow it.
 */
export function canActIgnoringLabelSelector(
  perms: Permission[],
  target: { type: string; namespace?: string },
  action: PermissionAction,
): boolean {
  return perms.some(
    (p) =>
      matchesType(p, target.type) &&
      matchesAction(p, action) &&
      namespaceMatches(p, target.namespace),
  );
}

export interface ListPlanEntry {
  /** undefined = every namespace (Cluster-scoped kind, or an unrestricted "all namespaces" grant). */
  namespace?: string;
  labelSelector?: string;
}

export type ListPlan = { mode: 'denied' } | { mode: 'list'; entries: ListPlanEntry[] };

function dedupeEntries(entries: ListPlanEntry[]): ListPlanEntry[] {
  const seen = new Map<string, ListPlanEntry>();
  for (const e of entries) {
    const key = `${e.namespace ?? ''}|${e.labelSelector ?? ''}`;
    if (!seen.has(key)) seen.set(key, e);
  }
  return [...seen.values()];
}

/**
 * Solves "k8s LIST takes one labelSelector, but a user can have several non-overlapping grants
 * for the same type": collapses to a single unrestricted entry whenever any applicable grant has
 * no labelSelector at all (it subsumes every narrower one), otherwise emits one entry per grant
 * for `executeListPlan` to fan out and merge. `action` is 'list' or 'watch' — for 'watch', the
 * result is only used for the upfront `hasAction`-style gate (see resource-routes.ts), never fed
 * into `executeListPlan`, since WatchHub filters every event independently per-subscriber instead.
 */
export function planList(
  perms: Permission[],
  descriptor: ResourceDescriptor,
  action: 'list' | 'watch',
  requestedNamespace: string | undefined,
): ListPlan {
  const applicable = perms.filter(
    (p) => matchesType(p, descriptor.kind) && matchesAction(p, action),
  );
  if (applicable.length === 0) return { mode: 'denied' };

  if (descriptor.scope === 'Cluster') {
    if (applicable.some((p) => !p.labelSelector)) {
      return { mode: 'list', entries: [{ labelSelector: undefined }] };
    }
    return {
      mode: 'list',
      entries: dedupeEntries(
        applicable.map((p) => ({ labelSelector: labelSelectorToString(p.labelSelector) })),
      ),
    };
  }

  if (requestedNamespace !== undefined) {
    const inScope = applicable.filter(
      (p) => p.namespaces.length === 0 || p.namespaces.includes(requestedNamespace),
    );
    if (inScope.length === 0) return { mode: 'denied' };
    if (inScope.some((p) => !p.labelSelector)) {
      return {
        mode: 'list',
        entries: [{ namespace: requestedNamespace, labelSelector: undefined }],
      };
    }
    return {
      mode: 'list',
      entries: dedupeEntries(
        inScope.map((p) => ({
          namespace: requestedNamespace,
          labelSelector: labelSelectorToString(p.labelSelector),
        })),
      ),
    };
  }

  // Namespaced kind, "list across every namespace" route.
  const entries: ListPlanEntry[] = [];
  for (const p of applicable) {
    if (p.namespaces.length === 0) {
      if (!p.labelSelector)
        return { mode: 'list', entries: [{ namespace: undefined, labelSelector: undefined }] };
      entries.push({ namespace: undefined, labelSelector: labelSelectorToString(p.labelSelector) });
    } else {
      for (const ns of p.namespaces) {
        entries.push({ namespace: ns, labelSelector: labelSelectorToString(p.labelSelector) });
      }
    }
  }
  return { mode: 'list', entries: dedupeEntries(entries) };
}

function andSelectors(a: string | undefined, b: string | undefined): string | undefined {
  return [a, b].filter(Boolean).join(',') || undefined;
}

/**
 * Executes a `planList` result against the k8s API as `'self'`. The common case is exactly one
 * entry (a direct passthrough with full pagination preserved); 2+ entries is a true fan-out of
 * non-overlapping grants — each listed to completion internally and merged/deduped by
 * `namespace/name`. v1 accepted limitation, called out explicitly: no `continueToken` support
 * across a multi-selector fan-out (fine for this tool's expected object counts).
 */
export async function executeListPlan<
  T extends { metadata?: { namespace?: string; name?: string } },
>(
  client: CustomResourceClient,
  descriptor: ResourceDescriptor,
  plan: Extract<ListPlan, { mode: 'list' }>,
  options: {
    extraLabelSelector?: string;
    fieldSelector?: string;
    limit?: number;
    continueToken?: string;
  },
): Promise<ListResult<T>> {
  async function listOne(entry: ListPlanEntry, listOptions: ListOptions): Promise<ListResult<T>> {
    if (descriptor.scope === 'Cluster')
      return client.list<T>(descriptor, 'self', undefined, listOptions);
    if (entry.namespace !== undefined)
      return client.list<T>(descriptor, 'self', entry.namespace, listOptions);
    return client.listAllNamespaces<T>(descriptor, 'self', listOptions);
  }

  if (plan.entries.length === 1) {
    const entry = plan.entries[0]!;
    return listOne(entry, {
      labelSelector: andSelectors(entry.labelSelector, options.extraLabelSelector),
      fieldSelector: options.fieldSelector,
      limit: options.limit,
      continueToken: options.continueToken,
    });
  }

  const merged = new Map<string, T>();
  for (const entry of plan.entries) {
    const labelSelector = andSelectors(entry.labelSelector, options.extraLabelSelector);
    let continueToken: string | undefined;
    do {
      const result = await listOne(entry, {
        labelSelector,
        fieldSelector: options.fieldSelector,
        continueToken,
      });
      for (const item of result.items) {
        merged.set(`${item.metadata?.namespace ?? ''}/${item.metadata?.name ?? ''}`, item);
      }
      continueToken = result.continueToken;
    } while (continueToken);
  }
  return { items: [...merged.values()] };
}

/** Approximates RFC 7396 merge-patch semantics for just `metadata.labels`, so PUT/PATCH can check
 * a permission against the object's post-mutation labels, not only its current ones — good enough
 * for a permission pre-check; the k8s API server remains the authoritative applier of the patch
 * itself. A `null` value in the patch deletes that label, matching merge-patch semantics. */
export function mergedLabelsAfterPatch(
  current: Record<string, string> | undefined,
  patchBody: unknown,
): Record<string, string> | undefined {
  const patchLabels = (
    patchBody as { metadata?: { labels?: Record<string, string | null> } } | undefined
  )?.metadata?.labels;
  if (!patchLabels) return current;
  const merged: Record<string, string> = { ...current };
  for (const [key, value] of Object.entries(patchLabels)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}
