import { resolveRefNamespace } from '@a5e/k8s-client';
import type { AnsibleHostSpec, Permission } from '@a5e/schemas';
import { canAct } from './permission-engine';

/**
 * Kinds whose spec can name an arbitrary `v1/Secret` and have the operator dereference it —
 * today only `varsBySecret` on the two host kinds (see hosts.ts). Every other Secret reference in
 * the schema points at a Secret through a CRD the permission engine already gates on its own
 * (`AnsibleSSHKey.spec.secretRef`, `AnsiblePlaybook.spec.source.git.*SecretRef`), so `use` grants
 * are deliberately not required for those.
 */
const KINDS_WITH_VARS_BY_SECRET = new Set(['AnsibleHost', 'ClusterAnsibleHost']);

export interface SecretUseDenial {
  name: string;
  namespace?: string;
  message: string;
}

/**
 * Enforces a `use` grant on the built-in `Secret` permission type (permissions.ts) for every
 * Secret an incoming AnsibleHost/ClusterAnsibleHost body would have the operator read.
 *
 * This is the *only* gate on that read: the operator resolves `varsBySecret` with its own
 * cluster-wide-privileged identity, never the requesting user's, so without this check any user
 * who can create a host could name any Secret its namespace rule allows and have its contents
 * rendered into a run. `resolveRefNamespace` supplies that namespace rule here exactly as it does
 * in the operator, so the API rejects a cross-namespace ref up front instead of letting it
 * through to fail later as a broken Run.
 *
 * Bodies may be partial (a merge patch): an entry-less body references nothing new and passes.
 * Refs already stored on the object aren't re-checked — they were checked when they were set,
 * the same way `canAct` treats an object's existing labels.
 *
 * A `Secret` grant is matched on namespace only — its `labelSelector` is not consulted, since
 * that would mean reading the Secret to see its labels, and a host may legitimately reference a
 * Secret that doesn't exist yet (declarative ordering). PermissionsEditor.vue hides the label
 * selector for this type so the restriction can't be set and silently ignored.
 *
 * Returns the first ref the caller may not use, or `undefined` if every one is allowed.
 */
export function deniedSecretUse(
  perms: Permission[],
  kind: string,
  /** The owning object's namespace — `undefined` for a cluster-scoped kind. */
  ownerNamespace: string | undefined,
  body: unknown,
): SecretUseDenial | undefined {
  if (!KINDS_WITH_VARS_BY_SECRET.has(kind)) return undefined;
  const entries = (body as { spec?: Pick<AnsibleHostSpec, 'varsBySecret'> } | undefined)?.spec
    ?.varsBySecret;
  if (!Array.isArray(entries)) return undefined;

  for (const entry of entries) {
    if (!entry?.name) {
      return { name: String(entry?.name ?? ''), message: 'varsBySecret entry needs a "name"' };
    }
    let namespace: string | undefined;
    try {
      namespace = resolveRefNamespace('Namespaced', entry.namespace, ownerNamespace);
    } catch (err) {
      return { name: entry.name, namespace: entry.namespace, message: (err as Error).message };
    }
    if (!namespace) {
      return {
        name: entry.name,
        message: `varsBySecret entry "${entry.name}" needs a namespace (${kind} is cluster-scoped)`,
      };
    }
    if (!canAct(perms, { type: 'Secret', namespace }, 'use')) {
      return {
        name: entry.name,
        namespace,
        message: `not allowed to use Secret ${namespace}/${entry.name}`,
      };
    }
  }
  return undefined;
}
