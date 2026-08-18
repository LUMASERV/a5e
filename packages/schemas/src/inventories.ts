import { z } from 'zod';
import { commonStatusFields, labelSelectorSchema } from './common';

export const hostSourceSchema = z.object({
  kind: z.enum(['AnsibleHost', 'ClusterAnsibleHost']),
  namespace: z.string().optional(),
  labelSelector: labelSelectorSchema,
});
export type HostSource = z.infer<typeof hostSourceSchema>;

export const inventoryGroupSchema = z.object({
  name: z.string(),
  hostSources: z.array(hostSourceSchema),
  vars: z.record(z.string(), z.unknown()).optional(),
  children: z.array(z.string()).optional(),
});
export type InventoryGroup = z.infer<typeof inventoryGroupSchema>;

export const ansibleInventorySpecSchema = z.object({
  vars: z.record(z.string(), z.unknown()).optional(),
  groups: z.array(inventoryGroupSchema),
});
export type AnsibleInventorySpec = z.infer<typeof ansibleInventorySpecSchema>;

export const ansibleInventoryStatusSchema = z.object({
  ...commonStatusFields,
  totalHosts: z.number().int().optional(),
  groupCounts: z.record(z.string(), z.number().int()).optional(),
});
export type AnsibleInventoryStatus = z.infer<typeof ansibleInventoryStatusSchema>;

export const clusterAnsibleInventorySpecSchema = ansibleInventorySpecSchema;
export const clusterAnsibleInventoryStatusSchema = ansibleInventoryStatusSchema;

/**
 * hostSources[].namespace semantics (enforced via CEL on each group's hostSources item, see gen/crd-yaml.ts):
 * - Parent AnsibleInventory (namespaced) + kind AnsibleHost      -> namespace must be absent (always own ns).
 * - Parent AnsibleInventory (namespaced) + kind ClusterAnsibleHost -> namespace must be absent (n/a, cluster-wide).
 * - Parent ClusterAnsibleInventory        + kind AnsibleHost      -> namespace REQUIRED.
 * - Parent ClusterAnsibleInventory        + kind ClusterAnsibleHost -> namespace must be absent (n/a, cluster-wide).
 */
export const HOST_SOURCE_CEL_NAMESPACED_PARENT =
  "self.kind != 'AnsibleHost' || !has(self.namespace)";
export const HOST_SOURCE_CEL_CLUSTER_PARENT =
  "self.kind != 'AnsibleHost' || has(self.namespace)";
