import { z } from 'zod';
import { labelSelectorSchema } from './common';
import { RESOURCE_DESCRIPTORS } from './crd-meta';

/**
 * Every kind a permission can target, derived from the same registry the CRUD routes/CRDs are
 * built from — `ChangeRequest` is registered there too (see change-requests.ts), so granting
 * `approve`/`propose` on it works through the exact same mechanism as every other kind, with
 * nothing kind-specific to maintain here. `Group` and `User` are deliberately excluded: their CRUD
 * routes are admin-only and never consult this engine at all (see crd-meta.ts's comments on those
 * descriptors for why), so granting e.g. "list User" would be a dead option the API never actually
 * checks — the exact class of bug already fixed once for type-inappropriate actions. Kinds that
 * aren't CRDs at all are appended from BUILTIN_PERMISSION_TYPES below.
 */
const EXCLUDED_PERMISSION_TYPES = new Set(['Group', 'User']);

/**
 * Kinds a permission can target that are NOT one of this project's CRDs, so they can't come from
 * RESOURCE_DESCRIPTORS. `Secret` is the built-in `v1/Secret`, and the only action it ever carries
 * is `use` — a5e never lists, reads back or writes a user's Secrets on their behalf, it only
 * *dereferences* one a spec names (`AnsibleHost.spec.varsBySecretRef`, see hosts.ts), which is
 * exactly the operation this gates.
 */
export const BUILTIN_PERMISSION_TYPES = ['Secret'] as const;

const allPermissionTypes: string[] = [
  ...RESOURCE_DESCRIPTORS.filter((d) => !EXCLUDED_PERMISSION_TYPES.has(d.kind)).map((d) => d.kind),
  ...BUILTIN_PERMISSION_TYPES,
];
export const PERMISSION_TYPES = allPermissionTypes as [string, ...string[]];
export const permissionTypeSchema = z.union([z.enum(PERMISSION_TYPES), z.literal('*')]);
export type PermissionType = (typeof PERMISSION_TYPES)[number] | '*';

export const PERMISSION_ACTIONS = [
  'list',
  'get',
  'watch',
  'create',
  'update',
  'delete',
  'trigger', // AnsibleJob "run now" (modules/ansiblejobs.ts)
  'cancel', // AnsibleRun cancel (modules/ansibleruns.ts)
  'retry', // AnsibleRun retry (modules/ansibleruns.ts) — 'get' also covers viewing/downloading logs
  'download', // AnsibleInventory/ClusterAnsibleInventory resolved-YAML export
  'import', // AnsibleSSHKey/ClusterAnsibleSSHKey generate/upload convenience routes
  'use', // v1/Secret dereferenced by AnsibleHost/ClusterAnsibleHost `varsBySecretRef`
  // (auth/secret-use.ts) — the only action the built-in `Secret` type takes
  'approve', // ChangeRequest approve AND decline — one action covers both
  'propose', // reserved: proposing a ChangeRequest is currently ungated for any logged-in user;
  // kept as a real action so a future tightening doesn't need a schema change.
] as const;
export const permissionActionSchema = z.union([z.enum(PERMISSION_ACTIONS), z.literal('*')]);
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number] | '*';

/**
 * One grant: `type` × `namespaces` × `labelSelector` × `actions`. Empty `namespaces` means every
 * namespace (meaningless/ignored for a Cluster-scoped type); an absent `labelSelector` means every
 * object regardless of labels; `actions` always has at least one entry, `'*'` meaning every action.
 * Assigned to a `User` (see users.ts's `userSpecSchema.permissions`) or to a `Group` (see
 * groups.ts) that a user's `impersonateGroups` references.
 */
export const permissionSchema = z.object({
  type: permissionTypeSchema,
  namespaces: z.array(z.string()).default([]),
  labelSelector: labelSelectorSchema.optional(),
  actions: z.array(permissionActionSchema).min(1),
});
export type Permission = z.infer<typeof permissionSchema>;
