import { parseExpression } from 'cron-parser';
import type { CustomResourceClient } from '@a5e/k8s-client';
import { API_GROUP, API_GROUP_VERSION, RESOURCE_DESCRIPTORS_BY_KIND } from '@a5e/schemas';
import type {
  AnsibleJobSpec,
  AnsibleJobStatus,
  AnsibleRunSpec,
  AnsibleRunStatus,
  CustomResource,
  ResourceDescriptor,
} from '@a5e/schemas';
import { patchReadyCondition } from './base-reconciler';

const JOB_LABEL = `${API_GROUP}/job`;
const runDescriptor = RESOURCE_DESCRIPTORS_BY_KIND.AnsibleRun!;
const ACTIVE_PHASES = new Set(['Pending', 'Resolving', 'Running']);
const TERMINAL_PHASES = new Set(['Succeeded', 'Failed', 'Error', 'Cancelled']);

function ownerRef(obj: CustomResource<AnsibleJobSpec, AnsibleJobStatus>) {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'AnsibleJob',
    name: obj.metadata.name,
    uid: obj.metadata.uid!,
    controller: true,
    blockOwnerDeletion: true,
  };
}

/** Most recent scheduled fire time at or before `now` — a single value regardless of how many
 * occurrences were missed, so operator downtime never causes a burst of catch-up runs. */
function mostRecentFireTime(schedule: string, now: Date): Date {
  return parseExpression(schedule, { currentDate: now }).prev().toDate();
}

async function listOwnedRuns(
  client: CustomResourceClient,
  namespace: string,
  jobName: string,
): Promise<CustomResource<AnsibleRunSpec, AnsibleRunStatus>[]> {
  const result = await client.list<CustomResource<AnsibleRunSpec, AnsibleRunStatus>>(runDescriptor, 'self', namespace, {
    labelSelector: `${JOB_LABEL}=${jobName}`,
  });
  return result.items;
}

async function pruneHistory(
  client: CustomResourceClient,
  namespace: string,
  runs: CustomResource<AnsibleRunSpec, AnsibleRunStatus>[],
  successfulLimit: number,
  failedLimit: number,
) {
  const byPhase = (predicate: (phase: string | undefined) => boolean) =>
    runs
      .filter((r) => predicate(r.status?.phase))
      .sort((a, b) => new Date(a.metadata.creationTimestamp ?? 0).getTime() - new Date(b.metadata.creationTimestamp ?? 0).getTime());

  const succeeded = byPhase((p) => p === 'Succeeded');
  const failed = byPhase((p) => p !== undefined && TERMINAL_PHASES.has(p) && p !== 'Succeeded');

  const toDelete = [
    ...succeeded.slice(0, Math.max(0, succeeded.length - successfulLimit)),
    ...failed.slice(0, Math.max(0, failed.length - failedLimit)),
  ];
  for (const run of toDelete) {
    await client.delete(runDescriptor, run.metadata.name, 'self', namespace).catch(() => {
      // best-effort — a run deleted concurrently (e.g. by a user) is not an error here
    });
  }
}

async function spawnRun(
  client: CustomResourceClient,
  obj: CustomResource<AnsibleJobSpec, AnsibleJobStatus>,
): Promise<string> {
  const namespace = obj.metadata.namespace!;
  const created = await client.create<CustomResource<AnsibleRunSpec, AnsibleRunStatus>>(
    runDescriptor,
    {
      apiVersion: API_GROUP_VERSION,
      kind: 'AnsibleRun',
      metadata: {
        generateName: `${obj.metadata.name}-`,
        namespace,
        labels: { [JOB_LABEL]: obj.metadata.name },
        ownerReferences: [ownerRef(obj)],
      },
      spec: obj.spec.template,
    },
    'self',
    namespace,
  );
  return created.metadata.name;
}

/**
 * One full pass over every AnsibleJob in the cluster — ticked on a fixed interval by
 * `CronTicker` (see k8s/cron-ticker.ts), not by the informer's event-driven workqueue like every
 * other controller: a schedule needs to be checked as time passes, not just when the object
 * itself changes. Runs only on the leader (CronTicker is registered inside the same
 * leader-gated `startControllers()` callback as everything else), so exactly one operator
 * replica ever spawns a Run for a given schedule tick.
 */
export async function reconcileAnsibleJobs(
  client: CustomResourceClient,
  descriptor: ResourceDescriptor,
  obj: CustomResource<AnsibleJobSpec, AnsibleJobStatus>,
): Promise<void> {
  const namespace = obj.metadata.namespace!;

  if (obj.spec.schedule) {
    let dueSince: Date;
    try {
      dueSince = mostRecentFireTime(obj.spec.schedule, new Date());
    } catch (err) {
      await patchReadyCondition(client, descriptor, obj, false, 'InvalidSchedule', (err as Error).message);
      return;
    }

    const lastScheduleTime = obj.status?.lastScheduleTime ? new Date(obj.status.lastScheduleTime) : new Date(obj.metadata.creationTimestamp!);
    const due = dueSince > lastScheduleTime;

    if (due && !obj.spec.suspend) {
      const activeRuns = (await listOwnedRuns(client, namespace, obj.metadata.name)).filter((r) =>
        ACTIVE_PHASES.has(r.status?.phase ?? 'Pending'),
      );

      if (activeRuns.length > 0 && obj.spec.concurrencyPolicy === 'Forbid') {
        // Skip this tick's occurrence entirely — still advance lastScheduleTime so it isn't
        // re-evaluated (and re-skipped) forever once the active run finally finishes.
        await client.patchStatus(descriptor, obj.metadata.name, { lastScheduleTime: new Date().toISOString() }, 'self', namespace);
      } else {
        if (activeRuns.length > 0 && obj.spec.concurrencyPolicy === 'Replace') {
          for (const run of activeRuns) {
            await client.patch(runDescriptor, run.metadata.name, { spec: { cancel: true } }, 'self', namespace);
          }
        }
        const runName = await spawnRun(client, obj);
        await client.patchStatus(
          descriptor,
          obj.metadata.name,
          { lastScheduleTime: new Date().toISOString(), lastRunRef: { name: runName } },
          'self',
          namespace,
        );
      }
    }
  }

  const allRuns = await listOwnedRuns(client, namespace, obj.metadata.name);
  await pruneHistory(client, namespace, allRuns, obj.spec.successfulRunsHistoryLimit, obj.spec.failedRunsHistoryLimit);

  const active = allRuns.filter((r) => ACTIVE_PHASES.has(r.status?.phase ?? 'Pending')).map((r) => ({ name: r.metadata.name }));
  await client.patchStatus(descriptor, obj.metadata.name, { active, observedGeneration: obj.metadata.generation }, 'self', namespace);
  await patchReadyCondition(client, descriptor, { ...obj, status: { ...obj.status, active } }, true, 'Ready', 'job is valid');
}
