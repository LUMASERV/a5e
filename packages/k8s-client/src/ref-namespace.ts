/**
 * Enforces the namespace-resolution rule from plan §2.2 for every ref field in the schema
 * (typed object refs like `playbookRef`/`inventoryRef`/`hostRef`, and untyped `{name,namespace?}`
 * refs like `secretRef`/`configMapRef`): a *namespaced* referencing/owning object may never be
 * given a foreign namespace — only a Cluster-scoped owner (pass `ownerNamespace: undefined`) may
 * legitimately point `ref.namespace` at a namespace other than its own.
 *
 * This matters because every caller resolves refs with the operator's own cluster-wide-privileged
 * `'self'` identity, never the requesting user's (see CustomResourceClient's CallerIdentity) — so
 * silently honoring an arbitrary `ref.namespace` here would let a user with only namespace-local
 * create-RBAC read/reconcile another namespace's objects, and (transitively, via secretRef/
 * sshKeySecretRef/basicAuthSecretRef fields on those objects) exfiltrate another namespace's
 * Secrets, with zero RBAC of their own in the target namespace. This was a real cross-tenant
 * vulnerability found across several call sites (host jumpHost.hostRef, AnsibleSSHKey's own
 * secretRef, AnsiblePlaybook's configMapRef/git secret refs, AnsibleRun's playbookRef/
 * inventoryRef) before this check existed.
 *
 * `targetScope: 'Cluster'` (only meaningful for typed object refs, never for Secret/ConfigMap
 * refs, which are always namespaced) means the ref's own target has no home namespace at all, so
 * this returns `undefined` regardless of `ownerNamespace` — the caller should not pass a
 * namespace to that lookup.
 */
export function resolveRefNamespace(
  targetScope: 'Namespaced' | 'Cluster',
  refNamespace: string | undefined,
  ownerNamespace: string | undefined,
): string | undefined {
  if (targetScope !== 'Namespaced') return undefined;
  if (ownerNamespace !== undefined && refNamespace !== undefined && refNamespace !== ownerNamespace) {
    throw new Error(
      `cross-namespace reference not allowed: namespace "${refNamespace}" referenced from namespace "${ownerNamespace}"`,
    );
  }
  return refNamespace ?? ownerNamespace;
}
