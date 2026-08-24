import type { CustomResourceClient } from '@a5e/k8s-client';
import type { Condition, CustomResource, ResourceDescriptor } from '@a5e/schemas';

/**
 * Sets/updates the `Ready` condition on a CR's status, preserving `lastTransitionTime` when the
 * status value (True/False) hasn't actually changed — the standard Kubernetes condition-update
 * convention, so `kubectl describe` age-since-transition stays meaningful.
 */
export async function patchReadyCondition<TSpec, TStatus extends { conditions?: Condition[] }>(
  client: CustomResourceClient,
  descriptor: ResourceDescriptor,
  obj: CustomResource<TSpec, TStatus>,
  ready: boolean,
  reason: string,
  message: string,
): Promise<void> {
  const now = new Date().toISOString();
  const existing = obj.status?.conditions ?? [];
  const previousReady = existing.find((c) => c.type === 'Ready');
  const status: Condition['status'] = ready ? 'True' : 'False';

  const readyCondition: Condition = {
    type: 'Ready',
    status,
    reason,
    message,
    observedGeneration: obj.metadata.generation,
    lastTransitionTime:
      previousReady && previousReady.status === status ? previousReady.lastTransitionTime : now,
  };

  if (
    previousReady?.status === status &&
    previousReady.reason === reason &&
    previousReady.message === message &&
    previousReady.observedGeneration === obj.metadata.generation
  ) {
    return; // nothing changed — skip the PATCH
  }

  const conditions = [readyCondition, ...existing.filter((c) => c.type !== 'Ready')];
  await client.patchStatus(
    descriptor,
    obj.metadata.name,
    { conditions, observedGeneration: obj.metadata.generation },
    'self',
    obj.metadata.namespace,
  );
}
