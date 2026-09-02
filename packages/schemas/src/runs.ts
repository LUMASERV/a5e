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

/**
 * Splits one AnsibleRun's execution across multiple Jobs/pods instead of a single pod running
 * `ansible-playbook` against every host. Every shard's pod is handed the SAME full inventory
 * (never a partial one — a play that reads `hostvars[<host outside this shard>]`, checks
 * `groups['x']` membership, or uses `run_once`/`serial`/`delegate_to` needs the rest of the
 * inventory to still be visible even though only some hosts are being acted on) and is scoped to
 * at most `maxAmountOfHosts` of those hosts purely via `ansible-playbook --limit` — the mechanism
 * Ansible itself provides for exactly this. The controller creates shard Jobs incrementally so at
 * most `maxConcurrentRuns` are ever in flight at once for this run (run-controller.ts's
 * startParallelRun/pollParallelRun) — never "spawn everything and let Kubernetes throttle it",
 * since a plain Job's `parallelism` field can't give each pod its own `--limit`.
 */
export const parallelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Hosts per shard pod. 1 means one pod per host. */
  maxAmountOfHosts: z.number().int().positive().default(1),
  /** Upper bound on shard pods running at the same time, regardless of how many shards the run has. */
  maxConcurrentRuns: z.number().int().positive().default(10),
});
export type ParallelConfig = z.infer<typeof parallelConfigSchema>;

export const runLogsSchema = z.object({
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
});
export type RunLogs = z.infer<typeof runLogsSchema>;

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
  parallel: parallelConfigSchema.optional(),
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

/**
 * One shard of a `parallel`-enabled run: its own Job/pod, its own `--limit`-scoped host subset,
 * its own phase/exit code/logs — everything pollRun already tracks at the top level, mirrored per
 * shard since a parallel run has no single Job to poll. `hosts` is for observability only
 * (rendered in the UI/`kubectl describe`) — every shard's pod mounts the SAME full inventory
 * ConfigMap (`status.resolvedInventoryConfigMapRef`), scoped down at runtime via `--limit` rather
 * than by giving each shard its own partial inventory (see `parallelConfigSchema`'s doc comment
 * for why).
 */
export const runShardStatusSchema = z.object({
  index: z.number().int().nonnegative(),
  hosts: z.array(z.string()),
  phase: runPhaseSchema.optional(),
  startTime: z.string().optional(),
  completionTime: z.string().optional(),
  jobRef: z.object({ name: z.string() }).optional(),
  podName: z.string().optional(),
  exitCode: z.number().int().optional(),
  failedStep: failedStepSchema.optional(),
  logs: runLogsSchema.optional(),
});
export type RunShardStatus = z.infer<typeof runShardStatusSchema>;

export const ansibleRunStatusSchema = z.object({
  ...commonStatusFields,
  phase: runPhaseSchema.optional(),
  startTime: z.string().optional(),
  completionTime: z.string().optional(),
  // jobRef/podName/exitCode/logs below describe the single Job/pod of a non-parallel run. A
  // `parallel`-enabled run instead fans out into `shards` — each with its own jobRef/podName/
  // exitCode/logs — and leaves these top-level fields unset (see run-controller.ts's
  // startParallelRun/pollParallelRun).
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
  logs: runLogsSchema.optional(),
  shards: z.array(runShardStatusSchema).optional(),
});
export type AnsibleRunStatus = z.infer<typeof ansibleRunStatusSchema>;
