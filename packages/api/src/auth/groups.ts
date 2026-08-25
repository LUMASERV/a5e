import { API_GROUP_VERSION, RESOURCE_DESCRIPTORS_BY_KIND } from '@a5e/schemas';
import type { CustomResource, GroupSpec, GroupStatus, Permission } from '@a5e/schemas';
import { client } from '../plugins/k8s';

/**
 * First-class named groups an admin defines permission grants for once, then assigns to local
 * users (User.spec.impersonateGroups — see auth/user-store.ts) or that OIDC group claims can
 * reference by name. A real
 * `Group` CRD (see crd-meta.ts) rather than a ConfigMap blob — same kubectl-visible, watchable
 * resource model as every other kind — but its routes (permissions-settings.ts) stay entirely
 * custom and admin-only, never gated by the fine-grained permission engine itself (see
 * crd-meta.ts's comment on the Group descriptor for why). A `Group` doesn't need to pre-exist for
 * a user/claim to reference its name; it just needs to exist (with permissions set) for that
 * reference to grant anything.
 */
const descriptor = RESOURCE_DESCRIPTORS_BY_KIND.Group!;
type GroupCR = CustomResource<GroupSpec, GroupStatus>;

export interface Group {
  name: string;
  permissions: Permission[];
}

function fromCR(cr: GroupCR): Group {
  return { name: cr.metadata.name, permissions: (cr.spec.permissions ?? []) as Permission[] };
}

function isNotFound(err: unknown): boolean {
  return (err as { code?: number }).code === 404;
}

export async function listGroups(): Promise<Group[]> {
  const result = await client.list<GroupCR>(descriptor, 'self');
  return result.items.map(fromCR);
}

export async function upsertGroup(name: string, permissions: Permission[]): Promise<void> {
  try {
    const existing = await client.get<GroupCR>(descriptor, name, 'self');
    await client.replace(descriptor, name, { ...existing, spec: { permissions } }, 'self');
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await client.create(
      descriptor,
      { apiVersion: API_GROUP_VERSION, kind: 'Group', metadata: { name }, spec: { permissions } },
      'self',
    );
  }
}

export async function deleteGroup(name: string): Promise<void> {
  try {
    await client.delete(descriptor, name, 'self');
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}
