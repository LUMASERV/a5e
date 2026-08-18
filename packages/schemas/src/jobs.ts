import { z } from 'zod';
import { commonStatusFields } from './common';
import { inventoryRefSchema, playbookRefSchema } from './refs';
import { ansibleOptionsSchema, resourceRequirementsSchema } from './runs';

/** Everything an AnsibleRun spawned from this Job is created with — the same shape as
 * AnsibleRunSpec minus `cancel` (a job spawns fresh runs; it never inherits a stale cancel flag). */
export const ansibleJobTemplateSchema = z.object({
  playbookRef: playbookRefSchema,
  inventoryRef: inventoryRefSchema,
  extraVars: z.record(z.string(), z.unknown()).optional(),
  ansibleOptions: ansibleOptionsSchema.optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  ttlSecondsAfterFinished: z.number().int().nonnegative().optional(),
  serviceAccountName: z.string().optional(),
  resources: resourceRequirementsSchema.optional(),
});
export type AnsibleJobTemplate = z.infer<typeof ansibleJobTemplateSchema>;

export const CONCURRENCY_POLICIES = ['Allow', 'Forbid', 'Replace'] as const;
export const concurrencyPolicySchema = z.enum(CONCURRENCY_POLICIES);
export type ConcurrencyPolicy = z.infer<typeof concurrencyPolicySchema>;

export const ansibleJobSpecSchema = z.object({
  template: ansibleJobTemplateSchema,
  // Standard 5-field cron expression (minute hour day-of-month month day-of-week). Omit for a
  // manual-trigger-only job — the operator never spawns runs on its own, only the API's
  // POST .../trigger route does, impersonated as whoever clicked it.
  schedule: z.string().optional(),
  suspend: z.boolean().default(false),
  concurrencyPolicy: concurrencyPolicySchema.default('Allow'),
  successfulRunsHistoryLimit: z.number().int().nonnegative().default(3),
  failedRunsHistoryLimit: z.number().int().nonnegative().default(1),
});
export type AnsibleJobSpec = z.infer<typeof ansibleJobSpecSchema>;

export const ansibleJobStatusSchema = z.object({
  ...commonStatusFields,
  lastScheduleTime: z.string().optional(),
  lastRunRef: z.object({ name: z.string() }).optional(),
  active: z.array(z.object({ name: z.string() })).optional(),
});
export type AnsibleJobStatus = z.infer<typeof ansibleJobStatusSchema>;
