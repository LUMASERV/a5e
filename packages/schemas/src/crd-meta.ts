import type { z } from 'zod';
import { changeRequestSpecSchema, changeRequestStatusSchema } from './change-requests';
import { API_GROUP, API_VERSION } from './common';
import { groupSpecSchema, groupStatusSchema } from './groups';
import {
  ansibleHostSpecSchema,
  ansibleHostStatusSchema,
  clusterAnsibleHostSpecSchema,
  clusterAnsibleHostStatusSchema,
} from './hosts';
import {
  ansibleInventorySpecSchema,
  ansibleInventoryStatusSchema,
  clusterAnsibleInventorySpecSchema,
  clusterAnsibleInventoryStatusSchema,
} from './inventories';
import { ansibleJobSpecSchema, ansibleJobStatusSchema } from './jobs';
import {
  ansiblePlaybookSpecSchema,
  ansiblePlaybookStatusSchema,
  clusterAnsiblePlaybookSpecSchema,
  clusterAnsiblePlaybookStatusSchema,
} from './playbooks';
import { ansibleRunSpecSchema, ansibleRunStatusSchema } from './runs';
import {
  ansibleSSHKeySpecSchema,
  ansibleSSHKeyStatusSchema,
  clusterAnsibleSSHKeySpecSchema,
  clusterAnsibleSSHKeyStatusSchema,
} from './sshkeys';
import { userSpecSchema, userStatusSchema } from './users';

export interface ResourceDescriptor {
  kind: string;
  plural: string;
  singular: string;
  scope: 'Namespaced' | 'Cluster';
  /** For a Cluster* kind, the namespaced sibling kind sharing its reconcile logic (if any). */
  pairedWith?: string;
  specSchema: z.ZodTypeAny;
  statusSchema: z.ZodTypeAny;
  /** Extra printer columns beyond the standard Ready/Age, as [name, jsonPath, type]. */
  printerColumns?: Array<{ name: string; jsonPath: string; type: string }>;
}

export const RESOURCE_DESCRIPTORS: ResourceDescriptor[] = [
  {
    kind: 'AnsibleHost',
    plural: 'ansiblehosts',
    singular: 'ansiblehost',
    scope: 'Namespaced',
    specSchema: ansibleHostSpecSchema,
    statusSchema: ansibleHostStatusSchema,
    printerColumns: [{ name: 'Address', jsonPath: '.spec.ansibleAddress', type: 'string' }],
  },
  {
    kind: 'ClusterAnsibleHost',
    plural: 'clusteransiblehosts',
    singular: 'clusteransiblehost',
    scope: 'Cluster',
    pairedWith: 'AnsibleHost',
    specSchema: clusterAnsibleHostSpecSchema,
    statusSchema: clusterAnsibleHostStatusSchema,
    printerColumns: [{ name: 'Address', jsonPath: '.spec.ansibleAddress', type: 'string' }],
  },
  {
    kind: 'AnsibleInventory',
    plural: 'ansibleinventories',
    singular: 'ansibleinventory',
    scope: 'Namespaced',
    specSchema: ansibleInventorySpecSchema,
    statusSchema: ansibleInventoryStatusSchema,
    printerColumns: [{ name: 'Hosts', jsonPath: '.status.totalHosts', type: 'integer' }],
  },
  {
    kind: 'ClusterAnsibleInventory',
    plural: 'clusteransibleinventories',
    singular: 'clusteransibleinventory',
    scope: 'Cluster',
    pairedWith: 'AnsibleInventory',
    specSchema: clusterAnsibleInventorySpecSchema,
    statusSchema: clusterAnsibleInventoryStatusSchema,
    printerColumns: [{ name: 'Hosts', jsonPath: '.status.totalHosts', type: 'integer' }],
  },
  {
    kind: 'AnsiblePlaybook',
    plural: 'ansibleplaybooks',
    singular: 'ansibleplaybook',
    scope: 'Namespaced',
    specSchema: ansiblePlaybookSpecSchema,
    statusSchema: ansiblePlaybookStatusSchema,
  },
  {
    kind: 'ClusterAnsiblePlaybook',
    plural: 'clusteransibleplaybooks',
    singular: 'clusteransibleplaybook',
    scope: 'Cluster',
    pairedWith: 'AnsiblePlaybook',
    specSchema: clusterAnsiblePlaybookSpecSchema,
    statusSchema: clusterAnsiblePlaybookStatusSchema,
  },
  {
    kind: 'AnsibleSSHKey',
    plural: 'ansiblesshkeys',
    singular: 'ansiblesshkey',
    scope: 'Namespaced',
    specSchema: ansibleSSHKeySpecSchema,
    statusSchema: ansibleSSHKeyStatusSchema,
    printerColumns: [{ name: 'KeyType', jsonPath: '.status.keyType', type: 'string' }],
  },
  {
    kind: 'ClusterAnsibleSSHKey',
    plural: 'clusteransiblesshkeys',
    singular: 'clusteransiblesshkey',
    scope: 'Cluster',
    pairedWith: 'AnsibleSSHKey',
    specSchema: clusterAnsibleSSHKeySpecSchema,
    statusSchema: clusterAnsibleSSHKeyStatusSchema,
    printerColumns: [{ name: 'KeyType', jsonPath: '.status.keyType', type: 'string' }],
  },
  {
    kind: 'AnsibleRun',
    plural: 'ansibleruns',
    singular: 'ansiblerun',
    scope: 'Namespaced',
    specSchema: ansibleRunSpecSchema,
    statusSchema: ansibleRunStatusSchema,
    printerColumns: [
      { name: 'Phase', jsonPath: '.status.phase', type: 'string' },
      { name: 'StartTime', jsonPath: '.status.startTime', type: 'string' },
    ],
  },
  {
    kind: 'AnsibleJob',
    plural: 'ansiblejobs',
    singular: 'ansiblejob',
    scope: 'Namespaced',
    specSchema: ansibleJobSpecSchema,
    statusSchema: ansibleJobStatusSchema,
    printerColumns: [
      { name: 'Schedule', jsonPath: '.spec.schedule', type: 'string' },
      { name: 'Suspend', jsonPath: '.spec.suspend', type: 'boolean' },
      { name: 'LastSchedule', jsonPath: '.status.lastScheduleTime', type: 'date' },
    ],
  },
  {
    kind: 'ChangeRequest',
    plural: 'changerequests',
    singular: 'changerequest',
    scope: 'Cluster',
    specSchema: changeRequestSpecSchema,
    statusSchema: changeRequestStatusSchema,
    printerColumns: [
      { name: 'Phase', jsonPath: '.status.phase', type: 'string' },
      { name: 'RequestedBy', jsonPath: '.spec.requestedBy', type: 'string' },
    ],
  },
  {
    // A named set of permission grants (see permissions.ts) a local user's `impersonateGroups`/
    // an OIDC group claim can reference by name — a real CRD like every other kind here (kubectl
    // visibility, watch/SSE for free) rather than a bespoke ConfigMap blob, even though its HTTP
    // routes stay entirely custom and admin-only (modules/permissions-settings.ts) rather than
    // going through the generic canAct-gated resource-routes factory: letting a *permission grant*
    // decide who can edit Group objects would let a sufficiently-broad grant (e.g. a `'*'` type
    // entry) hand itself more permissions, so Group management intentionally bypasses the
    // fine-grained engine entirely, admin role only — see PERMISSION_TYPES in permissions.ts,
    // which excludes 'Group' for the same reason (granting "list Group" would be a dead option
    // the API never actually checks).
    kind: 'Group',
    plural: 'groups',
    singular: 'group',
    scope: 'Cluster',
    specSchema: groupSpecSchema,
    statusSchema: groupStatusSchema,
  },
  {
    // Every identity that can log in — a real CRD for the same reasons as Group above (and its
    // routes are admin-only/canAct-bypassing for the same reason: letting a permission grant
    // decide who can edit User objects would let it hand itself a different role/more
    // permissions). `passwordHash` deliberately isn't part of this spec — see users.ts's doc
    // comment — it lives in a separate, narrowly-scoped Secret (auth/user-passwords.ts) so a
    // CRD-level read can never expose credential material.
    kind: 'User',
    plural: 'users',
    singular: 'user',
    scope: 'Cluster',
    specSchema: userSpecSchema,
    statusSchema: userStatusSchema,
    printerColumns: [
      { name: 'Username', jsonPath: '.spec.username', type: 'string' },
      { name: 'Role', jsonPath: '.spec.role', type: 'string' },
    ],
  },
];

export const RESOURCE_DESCRIPTORS_BY_KIND = Object.fromEntries(
  RESOURCE_DESCRIPTORS.map((d) => [d.kind, d]),
);

export function apiVersionOf(): string {
  return `${API_GROUP}/${API_VERSION}`;
}

export { API_GROUP, API_VERSION };
