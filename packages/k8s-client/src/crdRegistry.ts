import {
  API_GROUP,
  API_VERSION,
  RESOURCE_DESCRIPTORS,
  RESOURCE_DESCRIPTORS_BY_KIND,
} from '@a5e/schemas';
import type { ResourceDescriptor } from '@a5e/schemas';

export { API_GROUP, API_VERSION, RESOURCE_DESCRIPTORS, RESOURCE_DESCRIPTORS_BY_KIND };
export type { ResourceDescriptor };

export function descriptorForPlural(plural: string): ResourceDescriptor {
  const found = RESOURCE_DESCRIPTORS.find((d) => d.plural === plural);
  if (!found) throw new Error(`unknown resource plural: ${plural}`);
  return found;
}

/** Build the CustomObjectsApi-style base path for a kind, with or without a namespace segment. */
export function resourcePath(descriptor: ResourceDescriptor, namespace?: string): string {
  if (descriptor.scope === 'Namespaced') {
    if (!namespace) throw new Error(`${descriptor.kind} is namespaced — namespace is required`);
    return `/apis/${API_GROUP}/${API_VERSION}/namespaces/${namespace}/${descriptor.plural}`;
  }
  return `/apis/${API_GROUP}/${API_VERSION}/${descriptor.plural}`;
}

/**
 * Path for listing/watching a Namespaced kind across every namespace at once — the shape the
 * operator needs (it reconciles cluster-wide, not one namespace at a time). Kubernetes reuses
 * the same URL shape as a Cluster-scoped resource's list path; the API server itself decides
 * whether that means "all namespaces" or "the one cluster-scoped collection" based on how the
 * kind was registered.
 */
export function allNamespacesPath(descriptor: ResourceDescriptor): string {
  if (descriptor.scope !== 'Namespaced') {
    throw new Error(`${descriptor.kind} is not namespaced — use resourcePath instead`);
  }
  return `/apis/${API_GROUP}/${API_VERSION}/${descriptor.plural}`;
}
