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
 * `{ name, namespace? }` — the object a `varsFrom` entry points at. `min(1)` on both so the
 * generated CRD carries `minLength: 1` and the API server rejects an empty string: the API's own
 * `use`-grant check (api/src/auth/vars-from.ts) never sees a `kubectl apply`, and an empty name
 * would otherwise persist happily and only surface much later as a failed Run.
 */
const varsFromRefSchema = z.object({
  name: z.string().min(1),
  namespace: z.string().min(1).optional(),
});

/**
 * One source of host vars, shaped exactly like a container's `envFrom` entry: a list where each
 * item names a `v1/Secret` or a `v1/ConfigMap` and contributes every key in it as a host var of
 * the same name.
 *
 * Flat object + CEL rather than a Zod union, for the same reason PlaybookSource is (see
 * playbooks.ts): a Kubernetes structural schema forbids `anyOf` branches that each declare their
 * own `properties`.
 *
 * `namespace` is optional here and defaults to the host's own; a *namespaced* AnsibleHost may
 * never name a foreign one (resolveRefNamespace rejects it — see packages/k8s-client/src/
 * ref-namespace.ts). On ClusterAnsibleHost it is REQUIRED instead, there being no owning
 * namespace to default to — the same split AnsibleSSHKey/ClusterAnsibleSSHKey's `secretRef` uses.
 *
 * Unlike `envFrom` there is no `prefix` and no `optional`: nobody asked for either, a missing
 * source is a misconfiguration worth failing the Run over, and both are cheap to add later.
 */
export const varsFromSchema = z.object({
  secretRef: varsFromRefSchema.optional(),
  configMapRef: varsFromRefSchema.optional(),
});
export type VarsFrom = z.infer<typeof varsFromSchema>;

export const VARS_FROM_CEL = '(has(self.secretRef)?1:0) + (has(self.configMapRef)?1:0) == 1';
export const VARS_FROM_CEL_MESSAGE =
  'exactly one of varsFrom[].secretRef or varsFrom[].configMapRef must be set';

/** ClusterAnsibleHost variant: whichever ref is present must name a namespace. */
export const clusterVarsFromSchema = z.object({
  secretRef: varsFromRefSchema.extend({ namespace: z.string().min(1) }).optional(),
  configMapRef: varsFromRefSchema.extend({ namespace: z.string().min(1) }).optional(),
});

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
   * Host vars pulled from Secrets/ConfigMaps, merged in array order and BEFORE `vars` — a later
   * entry overrides an earlier one, and an inline `vars` entry with the same key beats them all,
   * being the more explicit of the two.
   *
   * A resolved value is never written into any generated artifact: the run's Job mounts a copy of
   * each referenced object and the rendered inventory reads the mounted file (see
   * inventory-render.ts's `varsFileLookup`). Secret-derived values are additionally masked in
   * every client-facing rendering (secret-masking.ts); ConfigMap-derived ones are not, that being
   * the point of the distinction.
   */
  varsFrom: z.array(varsFromSchema).optional(),
  // Disabled hosts are excluded from inventory resolution (resolveInventoryGroups) entirely —
  // a quick way to pull a host out of every inventory/run without deleting or un-labeling it.
  enabled: z.boolean().default(true),
});
export type AnsibleHostSpec = z.infer<typeof ansibleHostSpecSchema>;

export const ansibleHostStatusSchema = z.object(commonStatusFields);
export type AnsibleHostStatus = z.infer<typeof ansibleHostStatusSchema>;

// ClusterAnsibleHost: same shape, except each `varsFrom[]` ref's `namespace` is REQUIRED — a
// cluster-scoped object has no owning namespace to default to (same rule as
// ClusterAnsibleSSHKey's secretRef).
// The result is a narrowing of AnsibleHostSpec, so anything typed against that keeps accepting a
// ClusterAnsibleHost's spec.
export const clusterAnsibleHostSpecSchema = ansibleHostSpecSchema.extend({
  varsFrom: z.array(clusterVarsFromSchema).optional(),
});
export type ClusterAnsibleHostSpec = z.infer<typeof clusterAnsibleHostSpecSchema>;

export const clusterAnsibleHostStatusSchema = ansibleHostStatusSchema;
