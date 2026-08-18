import { resolveInventoryGroups, type CustomResourceClient } from '@a5e/k8s-client';
import type { AnsibleInventorySpec, AnsibleInventoryStatus, CustomResource, ResourceDescriptor } from '@a5e/schemas';
import { patchReadyCondition } from './base-reconciler';

/**
 * Computes diagnostic/display counts only (plan §2.6) — this status is NOT what a specific
 * AnsibleRun actually used; that's a separate, immutable snapshot taken at run time
 * (`AnsibleRun.status.resolvedInventoryConfigMapRef`, see run-controller.ts). Re-running this
 * resolution here just keeps `kubectl get`/the UI showing an approximately-live host count.
 */
export async function reconcileInventory(
  client: CustomResourceClient,
  descriptor: ResourceDescriptor,
  obj: CustomResource<AnsibleInventorySpec, AnsibleInventoryStatus>,
): Promise<void> {
  const inventoryNamespace = descriptor.scope === 'Namespaced' ? obj.metadata.namespace : undefined;

  let groups: Awaited<ReturnType<typeof resolveInventoryGroups>>;
  try {
    groups = await resolveInventoryGroups(client, 'self', obj.spec, inventoryNamespace);
  } catch (err) {
    await patchReadyCondition(
      client,
      descriptor,
      obj,
      false,
      'HostSourceNamespaceInvalid',
      `failed to resolve host sources: ${(err as Error).message}`,
    );
    return;
  }

  const groupCounts: Record<string, number> = {};
  const allHostKeys = new Set<string>();
  for (const group of groups) {
    groupCounts[group.name] = group.hosts.length;
    for (const host of group.hosts) allHostKeys.add(`${host.kind}/${host.namespace ?? ''}/${host.name}`);
  }

  const status: AnsibleInventoryStatus = {
    totalHosts: allHostKeys.size,
    groupCounts,
    observedGeneration: obj.metadata.generation,
  };
  await client.patchStatus(descriptor, obj.metadata.name, status, 'self', obj.metadata.namespace);

  const zeroMatchGroups = groups.filter((g) => g.hosts.length === 0).map((g) => g.name);
  if (zeroMatchGroups.length > 0) {
    await patchReadyCondition(
      client,
      descriptor,
      { ...obj, status },
      true,
      'SelectorMatchedZero',
      `group(s) with no matching hosts: ${zeroMatchGroups.join(', ')}`,
    );
    return;
  }
  await patchReadyCondition(client, descriptor, { ...obj, status }, true, 'Ready', 'inventory resolved');
}
