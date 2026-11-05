import { resolveRefNamespace } from '@a5e/k8s-client';
import type { AnsibleHostSpec, Permission } from '@a5e/schemas';
import { canActIgnoringLabelSelector } from './permission-engine';

/**
 * Kinds whose spec can name an arbitrary `v1/Secret` or `v1/ConfigMap` and have the operator
 * dereference it — today only `varsFrom` on the two host kinds (see hosts.ts). Every other such
 * reference in the schema points at its target through a CRD the permission engine already gates
 * on its own (`AnsibleSSHKey.spec.secretRef`, `AnsiblePlaybook.spec.source.configMapRef` and its
 * git auth refs), so `use` grants are deliberately not required for those.
 */
const KINDS_WITH_VARS_FROM = new Set(['AnsibleHost', 'ClusterAnsibleHost']);

export interface VarsFromDenial {
  type: 'Secret' | 'ConfigMap';
  name: string;
  namespace?: string;
  message: string;
}

/**
 * Enforces a `use` grant on the built-in `Secret`/`ConfigMap` permission types (permissions.ts)
 * for every object an incoming AnsibleHost/ClusterAnsibleHost body would have the operator read.
 *
 * This is the *only* gate on that read: the operator resolves `varsFrom` with its own
 * cluster-wide-privileged identity, never the requesting user's, so without this check any user
 * who can create a host could name any Secret or ConfigMap its namespace rule allows and have its
 * contents rendered into a run. A ConfigMap is gated for the same reason a Secret is — it is
 * someone else's data either way; only the masking of resolved values differs.
 * `resolveRefNamespace` supplies that namespace rule here exactly as it does in the operator, so
 * the API rejects a cross-namespace ref up front instead of letting it through to fail later as a
 * broken Run.
 *
 * Bodies may be partial (a merge patch): an entry-less body references nothing new and passes.
 * Refs already stored on the object aren't re-checked — they were checked when they were set,
 * the same way `canAct` treats an object's existing labels.
 *
 * Grants are matched on namespace only — hence `canActIgnoringLabelSelector` rather than `canAct`.
 * Evaluating a selector would mean reading the object to see its labels, and a host may
 * legitimately reference one that doesn't exist yet (declarative ordering). `permissionSchema`
 * rejects a `labelSelector` on these types outright and PermissionsEditor.vue hides the field.
 *
 * Returns the first ref the caller may not use, or `undefined` if every one is allowed.
 */
export function deniedVarsFromUse(
  perms: Permission[],
  kind: string,
  /** The owning object's namespace — `undefined` for a cluster-scoped kind. */
  ownerNamespace: string | undefined,
  body: unknown,
): VarsFromDenial | undefined {
  if (!KINDS_WITH_VARS_FROM.has(kind)) return undefined;
  const entries = (body as { spec?: Pick<AnsibleHostSpec, 'varsFrom'> } | undefined)?.spec
    ?.varsFrom;
  if (!Array.isArray(entries)) return undefined;

  for (const entry of entries) {
    const type = entry?.secretRef ? 'Secret' : 'ConfigMap';
    const ref = entry?.secretRef ?? entry?.configMapRef;
    if (!ref?.name) {
      return {
        type,
        name: String(ref?.name ?? ''),
        message: 'varsFrom entry needs exactly one of secretRef or configMapRef, with a name',
      };
    }
    let namespace: string | undefined;
    try {
      namespace = resolveRefNamespace('Namespaced', ref.namespace, ownerNamespace);
    } catch (err) {
      return { type, name: ref.name, namespace: ref.namespace, message: (err as Error).message };
    }
    if (!namespace) {
      return {
        type,
        name: ref.name,
        message: `varsFrom ${type} "${ref.name}" needs a namespace (${kind} is cluster-scoped)`,
      };
    }
    if (!canActIgnoringLabelSelector(perms, { type, namespace }, 'use')) {
      return {
        type,
        name: ref.name,
        namespace,
        message: `not allowed to use ${type} ${namespace}/${ref.name}`,
      };
    }
  }
  return undefined;
}
