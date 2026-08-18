import type { ResourceDescriptor } from '@a5e/schemas';

export function resourceBasePath(descriptor: ResourceDescriptor, namespace?: string): string {
  return descriptor.scope === 'Namespaced' ? `/namespaces/${namespace}/${descriptor.plural}` : `/${descriptor.plural}`;
}
