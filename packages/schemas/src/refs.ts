import { z } from 'zod';
import { API_GROUP } from './common';

/**
 * Per-relationship typed object references — explicit, Kubernetes-style
 * ({ apiGroup?, kind, name, namespace? }), never an implicit dual-scope resolve.
 *
 * Namespace resolution rule (enforced by CEL in the generated CRD, see gen/crd-yaml.ts):
 * - kind is a Cluster* kind -> namespace must be absent.
 * - kind is namespaced and the referencing object is namespaced -> namespace optional,
 *   defaults to the referencing object's own namespace.
 * - kind is namespaced and the referencing object is cluster-scoped -> namespace required.
 */
function objectRef<const K extends [string, ...string[]]>(kinds: K) {
  return z.object({
    apiGroup: z.string().default(API_GROUP).optional(),
    kind: z.enum(kinds),
    name: z.string(),
    namespace: z.string().optional(),
  });
}

export const hostRefSchema = objectRef(['AnsibleHost', 'ClusterAnsibleHost']);
export type HostRef = z.infer<typeof hostRefSchema>;

export const inventoryRefSchema = objectRef(['AnsibleInventory', 'ClusterAnsibleInventory']);
export type InventoryRef = z.infer<typeof inventoryRefSchema>;

export const playbookRefSchema = objectRef(['AnsiblePlaybook', 'ClusterAnsiblePlaybook']);
export type PlaybookRef = z.infer<typeof playbookRefSchema>;

export const sshKeyRefSchema = objectRef(['AnsibleSSHKey', 'ClusterAnsibleSSHKey']);
export type SSHKeyRef = z.infer<typeof sshKeyRefSchema>;

/** CEL rule shared by every ref field: Cluster* kinds must not carry a namespace. */
export const REF_CEL_CLUSTER_KIND_NO_NAMESPACE =
  "!self.kind.startsWith('Cluster') || !has(self.namespace)";
