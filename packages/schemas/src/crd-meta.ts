import type { z } from 'zod';
import { API_GROUP, API_VERSION } from './common';
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
];

export const RESOURCE_DESCRIPTORS_BY_KIND = Object.fromEntries(
  RESOURCE_DESCRIPTORS.map((d) => [d.kind, d]),
);

export function apiVersionOf(): string {
  return `${API_GROUP}/${API_VERSION}`;
}

export { API_GROUP, API_VERSION };
