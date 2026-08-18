import type { CustomResourceClient } from '@a5e/k8s-client';
import type { AnsibleHostSpec, AnsibleHostStatus, CustomResource, ResourceDescriptor } from '@a5e/schemas';
import { patchReadyCondition } from './base-reconciler';
import { resolveRef } from '../resolvers/object-ref';

/**
 * AnsibleHost/ClusterAnsibleHost have no external system to reconcile against — this is
 * intentionally a thin structural-validation + Ready-condition setter (plan §2.3), useful mainly
 * for catching a dangling `jumpHost.hostRef` early via `kubectl describe` rather than only at
 * AnsibleRun time. The one shared function is registered for both the namespaced and
 * Cluster-scoped kind (see main.ts) — same reconcile logic, different descriptor/scope.
 */
export async function reconcileHost(
  client: CustomResourceClient,
  descriptor: ResourceDescriptor,
  obj: CustomResource<AnsibleHostSpec, AnsibleHostStatus>,
): Promise<void> {
  const jumpRef = obj.spec.jumpHost?.hostRef;
  if (jumpRef) {
    try {
      // `obj.metadata.namespace` is already `undefined` for a ClusterAnsibleHost (no coercion to
      // '' here) — resolveRef treats that as "no namespace to restrict to", exactly the one case
      // where a foreign ref.namespace is legitimate (see resolveRef's own doc comment).
      await resolveRef(client, jumpRef, obj.metadata.namespace);
    } catch {
      await patchReadyCondition(
        client,
        descriptor,
        obj,
        false,
        'JumpHostNotFound',
        `jump host ${jumpRef.kind}/${jumpRef.namespace ? `${jumpRef.namespace}/` : ''}${jumpRef.name} not found`,
      );
      return;
    }
  }
  await patchReadyCondition(client, descriptor, obj, true, 'Ready', 'host is valid');
}
