import { resolveRefNamespace, type CustomResourceClient } from '@a5e/k8s-client';
import { RESOURCE_DESCRIPTORS_BY_KIND } from '@a5e/schemas';
import type { CustomResource } from '@a5e/schemas';

export interface Ref {
  kind: string;
  name: string;
  namespace?: string;
}

/**
 * Resolves a typed object ref, applying the namespace-resolution rule from plan §2.2 (see
 * `resolveRefNamespace` for the full rationale, shared with inventory-resolve.ts's jump-chain
 * resolution and run-controller.ts's Secret/ConfigMap ref resolution — this is security-critical
 * logic that must not have multiple, divergent copies). Pass `referencingNamespace: undefined`
 * when the referencing object is itself Cluster-scoped (no "own" namespace to restrict to) — only
 * then may `ref.namespace` legitimately name a different namespace.
 */
export async function resolveRef<TSpec, TStatus>(
  client: CustomResourceClient,
  ref: Ref,
  referencingNamespace: string | undefined,
): Promise<CustomResource<TSpec, TStatus>> {
  const descriptor = RESOURCE_DESCRIPTORS_BY_KIND[ref.kind];
  if (!descriptor) throw new Error(`unknown ref kind: ${ref.kind}`);
  const namespace = resolveRefNamespace(descriptor.scope, ref.namespace, referencingNamespace);
  return client.get<CustomResource<TSpec, TStatus>>(descriptor, ref.name, 'self', namespace);
}
