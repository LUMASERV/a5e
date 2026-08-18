import { z } from 'zod';
import { commonStatusFields } from './common';
import { hostRefSchema, sshKeyRefSchema } from './refs';

/**
 * Exactly one of address or hostRef must be set — a flat object with a CEL rule (see
 * gen/crd-yaml.ts), not a Zod union: Kubernetes structural schemas forbid anyOf/oneOf branches
 * from each declaring their own `properties`/`type` (only the PlaybookSource-style flat+CEL
 * pattern is expressible in a CRD), the same reason PlaybookSource is not a real Zod union.
 */
export const jumpHostSchema = z.object({
  address: z.string().optional(),
  user: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  hostRef: hostRefSchema.optional(),
});
export type JumpHost = z.infer<typeof jumpHostSchema>;

export const JUMP_HOST_CEL = '(has(self.address)?1:0) + (has(self.hostRef)?1:0) == 1';
export const JUMP_HOST_CEL_MESSAGE = 'exactly one of jumpHost.address or jumpHost.hostRef must be set';

// Hosts are always reached over SSH — there is no `connection` field (no local/winrm support).
// The SSH key lives on the host, not the run: different hosts commonly need different keys, and
// a run's inventory can span many hosts.
export const ansibleHostSpecSchema = z.object({
  ansibleHost: z.string().optional(),
  ansibleAddress: z.string().optional(),
  ansiblePort: z.number().int().min(1).max(65535).default(22),
  ansibleUser: z.string().default('root'),
  sshKeyRef: sshKeyRefSchema.optional(),
  jumpHost: jumpHostSchema.optional(),
  vars: z.record(z.string(), z.unknown()).optional(),
  // Disabled hosts are excluded from inventory resolution (resolveInventoryGroups) entirely —
  // a quick way to pull a host out of every inventory/run without deleting or un-labeling it.
  enabled: z.boolean().default(true),
});
export type AnsibleHostSpec = z.infer<typeof ansibleHostSpecSchema>;

export const ansibleHostStatusSchema = z.object(commonStatusFields);
export type AnsibleHostStatus = z.infer<typeof ansibleHostStatusSchema>;

// ClusterAnsibleHost has an identical spec/status shape.
export const clusterAnsibleHostSpecSchema = ansibleHostSpecSchema;
export const clusterAnsibleHostStatusSchema = ansibleHostStatusSchema;
