import { RESOURCE_DESCRIPTORS_BY_KIND } from '@a5e/schemas';
import type {
  AnsibleHostSpec,
  AnsibleHostStatus,
  AnsibleInventorySpec,
  AnsibleInventoryStatus,
  AnsibleJobSpec,
  AnsibleJobStatus,
  AnsiblePlaybookSpec,
  AnsiblePlaybookStatus,
  AnsibleRunSpec,
  AnsibleRunStatus,
  AnsibleSSHKeySpec,
  AnsibleSSHKeyStatus,
  ChangeRequestSpec,
  ChangeRequestStatus,
  ClusterAnsibleSSHKeySpec,
} from '@a5e/schemas';
import { createResourceStore } from './createResourceStore';

export const useHostStore = createResourceStore<AnsibleHostSpec, AnsibleHostStatus>(
  'host',
  RESOURCE_DESCRIPTORS_BY_KIND.AnsibleHost!,
);
export const useClusterHostStore = createResourceStore<AnsibleHostSpec, AnsibleHostStatus>(
  'clusterHost',
  RESOURCE_DESCRIPTORS_BY_KIND.ClusterAnsibleHost!,
);

export const useInventoryStore = createResourceStore<AnsibleInventorySpec, AnsibleInventoryStatus>(
  'inventory',
  RESOURCE_DESCRIPTORS_BY_KIND.AnsibleInventory!,
);
export const useClusterInventoryStore = createResourceStore<
  AnsibleInventorySpec,
  AnsibleInventoryStatus
>('clusterInventory', RESOURCE_DESCRIPTORS_BY_KIND.ClusterAnsibleInventory!);

export const usePlaybookStore = createResourceStore<AnsiblePlaybookSpec, AnsiblePlaybookStatus>(
  'playbook',
  RESOURCE_DESCRIPTORS_BY_KIND.AnsiblePlaybook!,
);
export const useClusterPlaybookStore = createResourceStore<
  AnsiblePlaybookSpec,
  AnsiblePlaybookStatus
>('clusterPlaybook', RESOURCE_DESCRIPTORS_BY_KIND.ClusterAnsiblePlaybook!);

export const useSSHKeyStore = createResourceStore<AnsibleSSHKeySpec, AnsibleSSHKeyStatus>(
  'sshKey',
  RESOURCE_DESCRIPTORS_BY_KIND.AnsibleSSHKey!,
);
export const useClusterSSHKeyStore = createResourceStore<
  ClusterAnsibleSSHKeySpec,
  AnsibleSSHKeyStatus
>('clusterSSHKey', RESOURCE_DESCRIPTORS_BY_KIND.ClusterAnsibleSSHKey!);

export const useRunStore = createResourceStore<AnsibleRunSpec, AnsibleRunStatus>(
  'run',
  RESOURCE_DESCRIPTORS_BY_KIND.AnsibleRun!,
);

export const useJobStore = createResourceStore<AnsibleJobSpec, AnsibleJobStatus>(
  'job',
  RESOURCE_DESCRIPTORS_BY_KIND.AnsibleJob!,
);

export const useChangeRequestStore = createResourceStore<ChangeRequestSpec, ChangeRequestStatus>(
  'changeRequest',
  RESOURCE_DESCRIPTORS_BY_KIND.ChangeRequest!,
);
