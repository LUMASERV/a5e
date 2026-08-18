import { z } from 'zod';
import { commonStatusFields } from './common';
import { inventoryRefSchema, playbookRefSchema } from './refs';

export const ansibleOptionsSchema = z.object({
  verbosity: z.number().int().min(0).max(4).optional(),
  tags: z.array(z.string()).optional(),
  skipTags: z.array(z.string()).optional(),
  limit: z.string().optional(),
  checkMode: z.boolean().optional(),
  forks: z.number().int().min(1).optional(),
});
export type AnsibleOptions = z.infer<typeof ansibleOptionsSchema>;

export const resourceRequirementsSchema = z.object({
  limits: z.record(z.string(), z.string()).optional(),
  requests: z.record(z.string(), z.string()).optional(),
});
export type ResourceRequirements = z.infer<typeof resourceRequirementsSchema>;

export const ansibleRunSpecSchema = z.object({
  playbookRef: playbookRefSchema,
  inventoryRef: inventoryRefSchema,
  // No sshKeyRef here — the SSH key is a property of each AnsibleHost (spec.sshKeyRef), since
  // different hosts in the same inventory commonly need different keys.
  extraVars: z.record(z.string(), z.unknown()).optional(),
  ansibleOptions: ansibleOptionsSchema.optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  ttlSecondsAfterFinished: z.number().int().nonnegative().optional(),
  serviceAccountName: z.string().optional(),
  resources: resourceRequirementsSchema.optional(),
  cancel: z.boolean().optional(),
});
export type AnsibleRunSpec = z.infer<typeof ansibleRunSpecSchema>;

export const RUN_PHASES = [
  'Pending',
  'Resolving',
  'Running',
  'Succeeded',
  'Failed',
  'Error',
  'Cancelled',
] as const;
export const runPhaseSchema = z.enum(RUN_PHASES);
export type RunPhase = z.infer<typeof runPhaseSchema>;

export const FAILED_STEPS = ['GitClone', 'DependencyInstall', 'Playbook'] as const;
export const failedStepSchema = z.enum(FAILED_STEPS);
export type FailedStep = z.infer<typeof failedStepSchema>;

export const ansibleRunStatusSchema = z.object({
  ...commonStatusFields,
  phase: runPhaseSchema.optional(),
  startTime: z.string().optional(),
  completionTime: z.string().optional(),
  jobRef: z.object({ name: z.string() }).optional(),
  podName: z.string().optional(),
  exitCode: z.number().int().optional(),
  failedStep: failedStepSchema.optional(),
  resolvedPlaybookRevision: z.string().optional(),
  resolvedInventoryConfigMapRef: z.object({ name: z.string() }).optional(),
  stats: z
    .object({
      ok: z.number().int().optional(),
      changed: z.number().int().optional(),
      unreachable: z.number().int().optional(),
      failed: z.number().int().optional(),
      skipped: z.number().int().optional(),
    })
    .optional(),
  logs: z
    .object({
      podRef: z.object({ name: z.string(), container: z.string() }).optional(),
      s3: z
        .object({
          bucket: z.string(),
          key: z.string(),
          endpoint: z.string().optional(),
          sizeBytes: z.number().int().optional(),
          uploadedAt: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});
export type AnsibleRunStatus = z.infer<typeof ansibleRunStatusSchema>;
