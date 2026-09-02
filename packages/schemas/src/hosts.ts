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
export const JUMP_HOST_CEL_MESSAGE =
  'exactly one of jumpHost.address or jumpHost.hostRef must be set';

/**
 * One `v1/Secret` whose every key becomes an Ansible host var on the referencing host — a way to
 * give a host credential-shaped vars (an API token, a DB password) without ever putting the value
 * itself in a CR that `kubectl get -o yaml` prints in full.
 *
 * `namespace` is optional here and defaults to the host's own; a *namespaced* AnsibleHost may
 * never name a foreign one (resolveRefNamespace rejects it — see packages/k8s-client/src/
 * ref-namespace.ts). On ClusterAnsibleHost it is REQUIRED instead, there being no owning
 * namespace to default to — exactly the split AnsibleSSHKey/ClusterAnsibleSSHKey's `secretRef`
 * already uses (sshkeys.ts).
 *
 * No `key` field on purpose: every key in the Secret becomes a var named after that key, so
 * adding a var is a Secret edit rather than a host edit.
 *
 * `min(1)` on both fields so the generated CRD carries `minLength: 1` and the API server itself
 * rejects an empty string. The API's own `use`-grant check (api/src/auth/secret-use.ts) already
 * refuses a nameless entry, but a `kubectl apply` bypasses that path entirely — and an empty name
 * would otherwise persist happily and only surface much later as a failed Run.
 */
export const varsBySecretRefSchema = z.object({
  name: z.string().min(1),
  namespace: z.string().min(1).optional(),
});
export type VarsBySecretRef = z.infer<typeof varsBySecretRefSchema>;

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
  /**
   * Secret-sourced host vars, merged in array order and BEFORE `vars` — a later entry overrides
   * an earlier one, and an inline `vars` entry with the same key beats them all, being the more
   * explicit of the two.
   *
   * A resolved value is never written into any generated artifact: the run's Job mounts a copy of
   * each referenced Secret and the rendered inventory reads the mounted file (see
   * inventory-render.ts's `secretVarLookup`), and every client-facing rendering masks the value
   * (secret-masking.ts).
   */
  varsBySecretRef: z.array(varsBySecretRefSchema).optional(),
  // Disabled hosts are excluded from inventory resolution (resolveInventoryGroups) entirely —
  // a quick way to pull a host out of every inventory/run without deleting or un-labeling it.
  enabled: z.boolean().default(true),
});
export type AnsibleHostSpec = z.infer<typeof ansibleHostSpecSchema>;

export const ansibleHostStatusSchema = z.object(commonStatusFields);
export type AnsibleHostStatus = z.infer<typeof ansibleHostStatusSchema>;

// ClusterAnsibleHost: same shape, except `varsBySecretRef[].namespace` is REQUIRED — a
// cluster-scoped object has no owning namespace to default to (same rule as
// ClusterAnsibleSSHKey's secretRef).
// The result is a narrowing of AnsibleHostSpec, so anything typed against that keeps accepting a
// ClusterAnsibleHost's spec.
export const clusterAnsibleHostSpecSchema = ansibleHostSpecSchema.extend({
  varsBySecretRef: z
    .array(varsBySecretRefSchema.extend({ namespace: z.string().min(1) }))
    .optional(),
});
export type ClusterAnsibleHostSpec = z.infer<typeof clusterAnsibleHostSpecSchema>;

export const clusterAnsibleHostStatusSchema = ansibleHostStatusSchema;
