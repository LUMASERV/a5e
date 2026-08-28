import {
  type CustomResourceClient,
  type ResolvedGroup,
  resolveInventoryGroups,
  resolveRefNamespace,
} from '@a5e/k8s-client';
import {
  API_GROUP_VERSION,
  type AnsibleInventorySpec,
  type AnsiblePlaybookSpec,
  type AnsibleRunSpec,
  type AnsibleRunStatus,
  type AnsibleSSHKeySpec,
  type AnsibleSSHKeyStatus,
  type ClusterAnsibleSSHKeySpec,
  type Condition,
  type CustomResource,
  type FailedStep,
  RESOURCE_DESCRIPTORS_BY_KIND,
  type ResourceDescriptor,
  type RunLogs,
  type RunShardStatus,
} from '@a5e/schemas';
import type * as k8s from '@kubernetes/client-node';
import type { CoreResources } from '../k8s/core';
import type { ReconcileResult } from '../k8s/informer';
import { type HostShard, groupsForHostNames, shardHosts } from '../resolvers/host-sharding';
import { renderInventoryIni } from '../resolvers/inventory-render';
import { type JobBuildInput, type SshKeyMount, buildJobSpec } from '../resolvers/job-builder';
import { resolveRef } from '../resolvers/object-ref';
import { buildRequirementsYaml } from '../resolvers/requirements-yaml';
import { type S3Config, uploadRunLog } from '../s3/uploader';

const TERMINAL_PHASES = new Set(['Succeeded', 'Failed', 'Error', 'Cancelled']);
const TERMINAL_SHARD_PHASES = new Set(['Succeeded', 'Failed', 'Error']);

function ownerRef(obj: CustomResource<AnsibleRunSpec, AnsibleRunStatus>): k8s.V1OwnerReference {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'AnsibleRun',
    name: obj.metadata.name,
    uid: obj.metadata.uid!,
    controller: true,
    blockOwnerDeletion: true,
  };
}

async function patchRunStatus(
  client: CustomResourceClient,
  descriptor: ResourceDescriptor,
  obj: CustomResource<AnsibleRunSpec, AnsibleRunStatus>,
  patch: Partial<AnsibleRunStatus>,
  conditionOverride?: { reason: string; message: string },
): Promise<void> {
  const merged: AnsibleRunStatus = {
    ...obj.status,
    ...patch,
    observedGeneration: obj.metadata.generation,
  };
  if (patch.phase) {
    const condition: Condition = {
      type: 'Ready',
      status: patch.phase === 'Succeeded' ? 'True' : 'False',
      reason: conditionOverride?.reason ?? patch.phase,
      message: conditionOverride?.message ?? `run is ${patch.phase.toLowerCase()}`,
      observedGeneration: obj.metadata.generation,
      lastTransitionTime: new Date().toISOString(),
    };
    merged.conditions = [condition];
  }
  await client.patchStatus(descriptor, obj.metadata.name, merged, 'self', obj.metadata.namespace);
}

/**
 * Resolves the SSH key each host in the inventory needs (a host property, not a run property —
 * different hosts commonly need different keys) and copies each *distinct* key's Secret into one
 * run-owned Secret, deduplicated so hosts sharing a key don't get redundant copies/volumes.
 * Mutates each `ResolvedHost` in place, setting `sshKeyMountName` to the mount the rendered
 * inventory's `ansible_ssh_private_key_file` line will point at.
 *
 * Returns `{ requeue: true }` if some host's SSHKey hasn't had its public key derived yet
 * (controller-ordering dependency on sshkey-controller.ts), or throws if any host has no
 * `sshKeyRef` at all — a hard requirement now that keys live on hosts, not the run.
 */
async function resolveHostSshKeys(
  client: CustomResourceClient,
  core: CoreResources,
  namespace: string,
  namePrefix: string,
  owner: k8s.V1OwnerReference,
  groups: ResolvedGroup[],
): Promise<{ requeue: true } | { requeue: false; mounts: SshKeyMount[] }> {
  const mountByRefKey = new Map<string, SshKeyMount>();
  const missingHosts: string[] = [];
  let mountIndex = 0;

  for (const group of groups) {
    for (const host of group.hosts) {
      const ref = host.spec.sshKeyRef;
      if (!ref) {
        missingHosts.push(`${host.kind}/${host.namespace ?? ''}/${host.name}`);
        continue;
      }

      const sshKeyDescriptor = RESOURCE_DESCRIPTORS_BY_KIND[ref.kind]!;
      // `host.namespace` is already `undefined` for a ClusterAnsibleHost — see
      // resolveRefNamespace's doc comment for why a namespaced host must never be allowed to
      // point sshKeyRef at a foreign namespace (this was a real cross-tenant vulnerability).
      const sshKeyNamespace = resolveRefNamespace(
        sshKeyDescriptor.scope,
        ref.namespace,
        host.namespace,
      );
      const refKey = `${ref.kind}/${sshKeyNamespace ?? ''}/${ref.name}`;

      let mount = mountByRefKey.get(refKey);
      if (!mount) {
        const sshKeyObj = await client.get<
          CustomResource<AnsibleSSHKeySpec | ClusterAnsibleSSHKeySpec, AnsibleSSHKeyStatus>
        >(sshKeyDescriptor, ref.name, 'self', sshKeyNamespace);
        if (!sshKeyObj.status?.publicKey) {
          return { requeue: true }; // sshkey-controller hasn't derived it yet
        }

        // Same rule for the AnsibleSSHKey's OWN secretRef: a namespaced AnsibleSSHKey must never
        // be allowed to point at a Secret in a different namespace either (the actual step in the
        // exploit chain that let a copied Secret's raw key bytes reach the attacker's namespace).
        const sshKeyOwnNamespace =
          sshKeyDescriptor.scope === 'Namespaced' ? sshKeyObj.metadata.namespace : undefined;
        const sourceSecretNamespace =
          resolveRefNamespace(
            'Namespaced',
            sshKeyObj.spec.secretRef.namespace,
            sshKeyOwnNamespace,
          ) ?? namespace;
        const sourceSecret = await core.getSecret(
          sourceSecretNamespace,
          sshKeyObj.spec.secretRef.name,
        );
        const sourceKey = sshKeyObj.spec.secretRef.key ?? 'ssh-privatekey';
        const mountName = `key${mountIndex++}`;
        const secretName = `${namePrefix}-sshkey-${mountName}`;
        await core.createOrUpdateSecret(namespace, {
          metadata: { name: secretName, namespace, ownerReferences: [owner] },
          type: 'Opaque',
          data: { 'ssh-privatekey': sourceSecret.data?.[sourceKey] ?? '' },
        });
        mount = { mountName, secretName };
        mountByRefKey.set(refKey, mount);
      }

      host.sshKeyMountName = mount.mountName;
    }
  }

  if (missingHosts.length > 0) {
    throw new Error(
      `host(s) missing spec.sshKeyRef, required to connect over SSH: ${missingHosts.join(', ')}`,
    );
  }

  return { requeue: false, mounts: [...mountByRefKey.values()] };
}

/** Everything both the single-Job and shard-Job paths need, resolved once up front. Re-resolving
 * this later (see pollParallelRun) to fill in shard slots as concurrency frees up is deliberately
 * safe to do again: every write here (Secrets, ConfigMaps) is an upsert keyed by a name derived
 * only from `namePrefix`, so re-running it reproduces the same objects rather than duplicating
 * them. */
interface PreparedRun {
  owner: k8s.V1OwnerReference;
  namePrefix: string;
  groups: ResolvedGroup[];
  inventoryVars: Record<string, unknown> | undefined;
  sshKeyMounts: SshKeyMount[];
  extraVarsConfigMapName: string;
  entryPoint: string;
  playbookConfigMapName?: string;
  gitSource?: JobBuildInput['gitSource'];
  playbookPath?: string;
  hasDependencies: boolean;
  requirementsConfigMapName?: string;
}

async function prepareRunResources(
  client: CustomResourceClient,
  core: CoreResources,
  obj: CustomResource<AnsibleRunSpec, AnsibleRunStatus>,
): Promise<{ requeue: true } | ({ requeue: false } & PreparedRun)> {
  const namespace = obj.metadata.namespace!;
  const runName = obj.metadata.name;

  const playbookObj = await resolveRef<AnsiblePlaybookSpec, unknown>(
    client,
    obj.spec.playbookRef,
    namespace,
  );
  const inventoryObj = await resolveRef<AnsibleInventorySpec, unknown>(
    client,
    obj.spec.inventoryRef,
    namespace,
  );

  const owner = ownerRef(obj);
  const namePrefix = `ansiblerun-${runName}`;

  // Inventory: resolve hosts + jump chains, then each host's own SSH key (plan: keys are a
  // host property, not a run property).
  // `inventoryObj.metadata.namespace` is already the resolved, validated namespace (or
  // `undefined` for a ClusterAnsibleInventory) — read it directly rather than recomputing from
  // `obj.spec.inventoryRef` a second time, so there's only one place (resolveRef, above) that
  // ever decides whether a cross-namespace inventoryRef was legitimate.
  const groups = await resolveInventoryGroups(
    client,
    'self',
    inventoryObj.spec,
    inventoryObj.metadata.namespace,
    true,
  );

  const sshKeyResult = await resolveHostSshKeys(client, core, namespace, namePrefix, owner, groups);
  if (sshKeyResult.requeue) {
    return { requeue: true }; // controller-ordering dependency — sshkey-controller hasn't derived it yet
  }

  // Extra vars: playbook defaults, then the run's own overrides win.
  const mergedExtraVars = {
    ...(playbookObj.spec.extraVars ?? {}),
    ...(obj.spec.extraVars ?? {}),
  };
  const extraVarsCm = await core.createOrUpdateConfigMap(namespace, {
    metadata: { name: `${namePrefix}-extravars`, namespace, ownerReferences: [owner] },
    data: { 'extra-vars.json': JSON.stringify(mergedExtraVars) },
  });

  // Playbook content: inline and configMapRef are both copied into one operator-owned ConfigMap
  // in the Run's namespace. This deviates from the plan's stated "configMapRef is mounted
  // directly, not snapshotted" — a Kubernetes Volume can only mount a ConfigMap in the SAME
  // namespace as the Pod, and a referenced ConfigMap can legitimately live in a different
  // namespace (or the playbook itself can), so direct cross-namespace mounting is not actually
  // possible. Copying is the only technically viable option; as a side effect it also pins
  // configMapRef content per-run, which is arguably more consistent (all three source kinds
  // are now equally reproducible) — documented here as a correction, not a silent departure.
  const entryPoint = playbookObj.spec.entryPoint ?? 'playbook.yml';
  let playbookConfigMapName: string | undefined;
  let gitSource: JobBuildInput['gitSource'];
  let playbookPath: string | undefined;

  // Namespaced AnsiblePlaybook must never be allowed to point its own configMapRef/git secret
  // refs at a foreign namespace either — same rule, same rationale as resolveRefNamespace's
  // doc comment (a namespaced owner's refs must stay in its own namespace).
  const playbookDescriptor = RESOURCE_DESCRIPTORS_BY_KIND[obj.spec.playbookRef.kind]!;
  const playbookOwnNamespace =
    playbookDescriptor.scope === 'Namespaced' ? playbookObj.metadata.namespace : undefined;

  if (playbookObj.spec.source.inline) {
    const cm = await core.createOrUpdateConfigMap(namespace, {
      metadata: { name: `${namePrefix}-playbook`, namespace, ownerReferences: [owner] },
      data: { [entryPoint]: playbookObj.spec.source.inline.playbook },
    });
    playbookConfigMapName = cm.metadata!.name!;
  } else if (playbookObj.spec.source.configMapRef) {
    const ref = playbookObj.spec.source.configMapRef;
    const refNamespace =
      resolveRefNamespace('Namespaced', ref.namespace, playbookOwnNamespace) ?? namespace;
    const sourceCm = await core.getConfigMap(refNamespace, ref.name);
    const key = ref.key ?? 'playbook.yml';
    const content = sourceCm.data?.[key];
    if (!content) throw new Error(`ConfigMap ${refNamespace}/${ref.name} has no key "${key}"`);
    const cm = await core.createOrUpdateConfigMap(namespace, {
      metadata: { name: `${namePrefix}-playbook`, namespace, ownerReferences: [owner] },
      data: { [entryPoint]: content },
    });
    playbookConfigMapName = cm.metadata!.name!;
  } else if (playbookObj.spec.source.git) {
    const git = playbookObj.spec.source.git;
    let sshKeySecretName: string | undefined;
    let basicAuthSecretName: string | undefined;

    if (git.sshKeySecretRef) {
      const secretNamespace =
        resolveRefNamespace('Namespaced', git.sshKeySecretRef.namespace, playbookOwnNamespace) ??
        namespace;
      const sourceSecret = await core.getSecret(secretNamespace, git.sshKeySecretRef.name);
      sshKeySecretName = `${namePrefix}-git-sshkey`;
      await core.createOrUpdateSecret(namespace, {
        metadata: { name: sshKeySecretName, namespace, ownerReferences: [owner] },
        type: sourceSecret.type,
        data: sourceSecret.data,
      });
    } else if (git.basicAuthSecretRef) {
      const secretNamespace =
        resolveRefNamespace('Namespaced', git.basicAuthSecretRef.namespace, playbookOwnNamespace) ??
        namespace;
      const sourceSecret = await core.getSecret(secretNamespace, git.basicAuthSecretRef.name);
      basicAuthSecretName = `${namePrefix}-git-basicauth`;
      await core.createOrUpdateSecret(namespace, {
        metadata: { name: basicAuthSecretName, namespace, ownerReferences: [owner] },
        type: sourceSecret.type,
        data: sourceSecret.data,
      });
    }

    gitSource = { url: git.url, revision: git.revision, sshKeySecretName, basicAuthSecretName };
    playbookPath = git.path;
  }

  // Dependencies (Galaxy roles/collections).
  const hasDependencies = Boolean(
    playbookObj.spec.dependencies?.roles?.length ||
      playbookObj.spec.dependencies?.collections?.length,
  );
  let requirementsConfigMapName: string | undefined;
  if (hasDependencies) {
    const cm = await core.createOrUpdateConfigMap(namespace, {
      metadata: { name: `${namePrefix}-requirements`, namespace, ownerReferences: [owner] },
      data: { 'requirements.yml': buildRequirementsYaml(playbookObj.spec.dependencies!) },
    });
    requirementsConfigMapName = cm.metadata!.name!;
  }

  return {
    requeue: false,
    owner,
    namePrefix,
    groups,
    inventoryVars: inventoryObj.spec.vars,
    sshKeyMounts: sshKeyResult.mounts,
    extraVarsConfigMapName: extraVarsCm.metadata!.name!,
    entryPoint,
    playbookConfigMapName,
    gitSource,
    playbookPath,
    hasDependencies,
    requirementsConfigMapName,
  };
}

function jobBuildInputFor(
  obj: CustomResource<AnsibleRunSpec, AnsibleRunStatus>,
  runnerImage: string,
  prep: PreparedRun,
  inventoryConfigMapName: string,
  nameSuffix?: string,
): JobBuildInput {
  return {
    runName: obj.metadata.name,
    runUid: obj.metadata.uid!,
    namespace: obj.metadata.namespace!,
    runnerImage,
    nameSuffix,
    inventoryConfigMapName,
    playbookConfigMapName: prep.playbookConfigMapName,
    gitSource: prep.gitSource,
    playbookPath: prep.playbookPath,
    entryPoint: prep.entryPoint,
    hasDependencies: prep.hasDependencies,
    requirementsConfigMapName: prep.requirementsConfigMapName,
    extraVarsConfigMapName: prep.extraVarsConfigMapName,
    sshKeyMounts: prep.sshKeyMounts,
    ansibleOptions: obj.spec.ansibleOptions,
    timeoutSeconds: obj.spec.timeoutSeconds,
    serviceAccountName: obj.spec.serviceAccountName,
    resources: obj.spec.resources as k8s.V1ResourceRequirements | undefined,
  };
}

/**
 * Creates one shard's inventory ConfigMap + Job and returns its initial `Running` status. Safe to
 * call again for the same `shard.index` (both writes are upserts — `createJob` in particular
 * falls back to reading the existing Job on a 409), which is exactly what happens when
 * `pollParallelRun` fills a previously-`Pending` slot after `prepareRunResources` re-resolved
 * everything from scratch.
 */
async function startShardJob(
  core: CoreResources,
  runnerImage: string,
  obj: CustomResource<AnsibleRunSpec, AnsibleRunStatus>,
  prep: PreparedRun,
  shard: HostShard,
): Promise<RunShardStatus> {
  const namespace = obj.metadata.namespace!;
  const inventoryIni = renderInventoryIni(prep.inventoryVars, shard.groups);
  const inventoryCm = await core.createOrUpdateConfigMap(namespace, {
    metadata: {
      name: `${prep.namePrefix}-inventory-${shard.index}`,
      namespace,
      ownerReferences: [prep.owner],
    },
    data: { 'inventory.ini': inventoryIni },
  });

  const jobSpec = buildJobSpec(
    jobBuildInputFor(obj, runnerImage, prep, inventoryCm.metadata!.name!, String(shard.index)),
  );
  const job = await core.createJob(namespace, jobSpec);

  return {
    index: shard.index,
    hosts: shard.hostNames,
    phase: 'Running',
    startTime: new Date().toISOString(),
    jobRef: { name: job.metadata!.name! },
  };
}

/**
 * Main AnsibleRun reconcile flow (plan §3.4). Simplification vs. the plan's full aspiration: a
 * single `Ready` condition tracks phase instead of separate Resolved/JobCreated/LogsPersisted
 * conditions — `status.phase`/`status.failedStep` already give callers the granularity that
 * matters; splitting conditions further was cut for time.
 */
export async function reconcileRun(
  client: CustomResourceClient,
  core: CoreResources,
  descriptor: ResourceDescriptor,
  runnerImage: string,
  s3Config: S3Config | undefined,
  obj: CustomResource<AnsibleRunSpec, AnsibleRunStatus>,
): Promise<ReconcileResult> {
  const status = obj.status ?? {};
  const namespace = obj.metadata.namespace!;

  if (obj.spec.cancel && status.phase && !TERMINAL_PHASES.has(status.phase)) {
    if (status.jobRef) {
      await core.deleteJob(namespace, status.jobRef.name).catch(() => undefined);
    }
    for (const shard of status.shards ?? []) {
      if (shard.jobRef) {
        await core.deleteJob(namespace, shard.jobRef.name).catch(() => undefined);
      }
    }
    await patchRunStatus(client, descriptor, obj, {
      phase: 'Cancelled',
      completionTime: new Date().toISOString(),
    });
    return;
  }

  if (status.phase && TERMINAL_PHASES.has(status.phase)) {
    return; // done — logs were already finalized when the phase was set terminal (see pollRun)
  }

  if (status.phase === 'Running') {
    if (status.shards) return pollParallelRun(client, core, descriptor, runnerImage, s3Config, obj);
    if (status.jobRef) return pollRun(client, core, descriptor, s3Config, obj);
  }

  return startRun(client, core, descriptor, runnerImage, obj);
}

async function startRun(
  client: CustomResourceClient,
  core: CoreResources,
  descriptor: ResourceDescriptor,
  runnerImage: string,
  obj: CustomResource<AnsibleRunSpec, AnsibleRunStatus>,
): Promise<ReconcileResult> {
  const namespace = obj.metadata.namespace!;
  const runName = obj.metadata.name;

  try {
    if (obj.status?.phase !== 'Resolving') {
      await patchRunStatus(client, descriptor, obj, { phase: 'Resolving' });
    }

    const prep = await prepareRunResources(client, core, obj);
    if (prep.requeue) {
      return { requeueAfterMs: 3000 }; // controller-ordering dependency — sshkey-controller hasn't derived it yet
    }

    if (obj.spec.parallel?.enabled) {
      return startParallelRun(client, descriptor, core, runnerImage, obj, prep);
    }

    const inventoryCm = await core.createOrUpdateConfigMap(namespace, {
      metadata: { name: `${prep.namePrefix}-inventory`, namespace, ownerReferences: [prep.owner] },
      data: { 'inventory.ini': renderInventoryIni(prep.inventoryVars, prep.groups) },
    });

    const jobSpec = buildJobSpec(
      jobBuildInputFor(obj, runnerImage, prep, inventoryCm.metadata!.name!),
    );
    const job = await core.createJob(namespace, jobSpec);

    await patchRunStatus(client, descriptor, obj, {
      phase: 'Running',
      startTime: new Date().toISOString(),
      jobRef: { name: job.metadata!.name! },
      resolvedInventoryConfigMapRef: { name: inventoryCm.metadata!.name! },
    });
    return { requeueAfterMs: 3000 };
  } catch (err) {
    console.error(`[AnsibleRun] ${namespace}/${runName} failed to start`, err);
    await patchRunStatus(
      client,
      descriptor,
      obj,
      { phase: 'Error', completionTime: new Date().toISOString() },
      { reason: 'Error', message: (err as Error).message },
    );
    return;
  }
}

/**
 * Splits the resolved inventory into shards (host-sharding.ts) and starts as many as
 * `parallel.maxConcurrentRuns` allows right away; the rest are recorded `Pending` and picked up
 * by `pollParallelRun` as earlier shards finish. A run whose inventory resolves to zero hosts
 * finishes immediately — same as `ansible-playbook` against an empty inventory, nothing to do,
 * not a failure.
 */
async function startParallelRun(
  client: CustomResourceClient,
  descriptor: ResourceDescriptor,
  core: CoreResources,
  runnerImage: string,
  obj: CustomResource<AnsibleRunSpec, AnsibleRunStatus>,
  prep: PreparedRun,
): Promise<ReconcileResult> {
  const { maxAmountOfHosts, maxConcurrentRuns } = obj.spec.parallel!;
  const shards = shardHosts(prep.groups, maxAmountOfHosts);

  if (shards.length === 0) {
    await patchRunStatus(client, descriptor, obj, {
      phase: 'Succeeded',
      startTime: new Date().toISOString(),
      completionTime: new Date().toISOString(),
      shards: [],
    });
    return;
  }

  const shardStatuses: RunShardStatus[] = [];
  for (const shard of shards) {
    const activeCount = shardStatuses.filter((s) => s.phase === 'Running').length;
    shardStatuses.push(
      activeCount < maxConcurrentRuns
        ? await startShardJob(core, runnerImage, obj, prep, shard)
        : { index: shard.index, hosts: shard.hostNames, phase: 'Pending' },
    );
  }

  await patchRunStatus(client, descriptor, obj, {
    phase: 'Running',
    startTime: new Date().toISOString(),
    shards: shardStatuses,
  });
  return { requeueAfterMs: 3000 };
}

const STEP_BY_INIT_CONTAINER: Record<string, FailedStep> = {
  'fetch-content': 'GitClone',
  'install-dependencies': 'DependencyInstall',
};

function determineFailedStep(pod: k8s.V1Pod): FailedStep | undefined {
  for (const s of pod.status?.initContainerStatuses ?? []) {
    if (s.state?.terminated && s.state.terminated.exitCode !== 0 && s.name) {
      const step = STEP_BY_INIT_CONTAINER[s.name];
      if (step) return step;
    }
  }
  const main = (pod.status?.containerStatuses ?? []).find((c) => c.name === 'ansible-playbook');
  if (main?.state?.terminated && main.state.terminated.exitCode !== 0) return 'Playbook';
  return undefined;
}

function mainExitCode(pod: k8s.V1Pod): number | undefined {
  return (pod.status?.containerStatuses ?? []).find((c) => c.name === 'ansible-playbook')?.state
    ?.terminated?.exitCode;
}

interface JobPollResult {
  succeeded: boolean;
  podName?: string;
  exitCode?: number;
  failedStep?: FailedStep;
  logs?: RunLogs;
}

/**
 * Polls one Job to completion (shared by the single-Job and per-shard paths — a shard's Job is
 * exactly as self-contained as a non-parallel run's). Returns `undefined` while the Job is still
 * running, `'not-found'` if it disappeared out from under the run (e.g. deleted by hand), or the
 * gathered pod/log/exit-code result once it has succeeded or failed. `logKey` is the S3 object
 * key logs are archived under — namespaced by shard index for a parallel run so shards' logs
 * never collide.
 */
async function pollJobToCompletion(
  core: CoreResources,
  namespace: string,
  jobName: string,
  s3Config: S3Config | undefined,
  logKey: string,
  ttlSecondsAfterFinished: number,
): Promise<JobPollResult | 'not-found' | undefined> {
  let job: k8s.V1Job;
  try {
    job = await core.getJob(namespace, jobName);
  } catch {
    return 'not-found';
  }

  const succeeded = (job.status?.succeeded ?? 0) > 0;
  const failed = (job.status?.failed ?? 0) > 0;
  if (!succeeded && !failed) {
    return undefined; // still running — plain re-poll, not an error/backoff case
  }

  const pods = await core.listPodsForJob(namespace, jobName).catch(() => [] as k8s.V1Pod[]);
  const pod = pods[0];
  const podName = pod?.metadata?.name;
  const failedStep = pod ? determineFailedStep(pod) : undefined;
  const exitCode = pod ? mainExitCode(pod) : undefined;

  let fullLogs = '';
  if (pod && podName) {
    const containerNames = [
      ...(pod.spec?.initContainers ?? []).map((c) => c.name),
      ...(pod.spec?.containers ?? []).map((c) => c.name),
    ].filter((n): n is string => Boolean(n));
    const chunks: string[] = [];
    for (const name of containerNames) {
      try {
        chunks.push(`==== ${name} ====\n${await core.getPodLog(namespace, podName, name)}`);
      } catch {
        // container may never have started (e.g. a later init container after an earlier failure)
      }
    }
    fullLogs = chunks.join('\n\n');
  }

  let logs: RunLogs | undefined = podName
    ? { podRef: { name: podName, container: 'ansible-playbook' } }
    : undefined;
  if (s3Config) {
    try {
      const result = await uploadRunLog(s3Config, logKey, fullLogs);
      logs = {
        ...logs,
        s3: {
          bucket: s3Config.bucket,
          key: logKey,
          endpoint: s3Config.endpoint,
          sizeBytes: result.sizeBytes,
          uploadedAt: new Date().toISOString(),
        },
      };
    } catch (err) {
      console.error(`[AnsibleRun] ${namespace}/${jobName} S3 log upload failed`, err);
    }
  }

  // Only shorten the Job's TTL once log capture is resolved (uploaded, or permanently given up
  // on) — this ordering is what protects logs from GC racing the upload (plan §3.4 step 3g).
  await core
    .patchJob(namespace, jobName, { spec: { ttlSecondsAfterFinished } })
    .catch(() => undefined);

  return { succeeded, podName, exitCode, failedStep, logs };
}

async function pollRun(
  client: CustomResourceClient,
  core: CoreResources,
  descriptor: ResourceDescriptor,
  s3Config: S3Config | undefined,
  obj: CustomResource<AnsibleRunSpec, AnsibleRunStatus>,
): Promise<ReconcileResult> {
  const namespace = obj.metadata.namespace!;
  const jobName = obj.status!.jobRef!.name;

  const result = await pollJobToCompletion(
    core,
    namespace,
    jobName,
    s3Config,
    `${namespace}/${obj.metadata.name}/log.txt`,
    obj.spec.ttlSecondsAfterFinished ?? 3600,
  );

  if (result === 'not-found') {
    await patchRunStatus(
      client,
      descriptor,
      obj,
      { phase: 'Error', completionTime: new Date().toISOString() },
      { reason: 'JobNotFound', message: `Job ${namespace}/${jobName} not found` },
    );
    return;
  }
  if (!result) {
    return { requeueAfterMs: 5000 };
  }

  await patchRunStatus(client, descriptor, obj, {
    phase: result.succeeded ? 'Succeeded' : 'Failed',
    completionTime: new Date().toISOString(),
    podName: result.podName,
    exitCode: result.exitCode,
    failedStep: result.failedStep,
    logs: result.logs,
  });
}

/** Shard-scoped counterpart of `pollRun` — same completion polling, but returns the updated shard
 * status instead of patching the whole run (pollParallelRun batches all shards into one patch). */
async function pollShardJob(
  core: CoreResources,
  namespace: string,
  runName: string,
  shard: RunShardStatus,
  s3Config: S3Config | undefined,
  ttlSecondsAfterFinished: number,
): Promise<RunShardStatus | undefined> {
  if (!shard.jobRef) return undefined;

  const result = await pollJobToCompletion(
    core,
    namespace,
    shard.jobRef.name,
    s3Config,
    `${namespace}/${runName}/shard-${shard.index}/log.txt`,
    ttlSecondsAfterFinished,
  );

  if (result === 'not-found') {
    return { ...shard, phase: 'Error', completionTime: new Date().toISOString() };
  }
  if (!result) return undefined; // still running, nothing changed for this shard

  return {
    ...shard,
    phase: result.succeeded ? 'Succeeded' : 'Failed',
    completionTime: new Date().toISOString(),
    podName: result.podName,
    exitCode: result.exitCode,
    failedStep: result.failedStep,
    logs: result.logs,
  };
}

/**
 * Polls every in-flight shard, then tops back up to `parallel.maxConcurrentRuns` from whichever
 * shards are still `Pending` — so the run always has at most that many pods live at once, and a
 * finishing shard immediately frees its slot for the next one instead of waiting for the whole
 * batch. Re-resolving the inventory (`prepareRunResources`) only happens when there's actually a
 * pending shard to start; once every shard has a Job, later ticks are pure polling.
 */
async function pollParallelRun(
  client: CustomResourceClient,
  core: CoreResources,
  descriptor: ResourceDescriptor,
  runnerImage: string,
  s3Config: S3Config | undefined,
  obj: CustomResource<AnsibleRunSpec, AnsibleRunStatus>,
): Promise<ReconcileResult> {
  const namespace = obj.metadata.namespace!;
  const runName = obj.metadata.name;
  const ttlSecondsAfterFinished = obj.spec.ttlSecondsAfterFinished ?? 3600;
  const maxConcurrentRuns = obj.spec.parallel!.maxConcurrentRuns;

  let changed = false;
  const updated: RunShardStatus[] = [];
  for (const shard of obj.status!.shards!) {
    if (shard.phase === 'Running') {
      const polled = await pollShardJob(
        core,
        namespace,
        runName,
        shard,
        s3Config,
        ttlSecondsAfterFinished,
      );
      if (polled) {
        updated.push(polled);
        changed = true;
        continue;
      }
    }
    updated.push(shard);
  }

  let freeSlots = maxConcurrentRuns - updated.filter((s) => s.phase === 'Running').length;
  const hasPending = updated.some((s) => s.phase === 'Pending');

  if (freeSlots > 0 && hasPending) {
    try {
      const prep = await prepareRunResources(client, core, obj);
      if (!prep.requeue) {
        for (let i = 0; i < updated.length && freeSlots > 0; i++) {
          if (updated[i]!.phase !== 'Pending') continue;
          const pendingShard = updated[i]!;
          const shard: HostShard = {
            index: pendingShard.index,
            hostNames: pendingShard.hosts,
            groups: groupsForHostNames(prep.groups, pendingShard.hosts),
          };
          updated[i] = await startShardJob(core, runnerImage, obj, prep, shard);
          freeSlots--;
          changed = true;
        }
      }
    } catch (err) {
      console.error(`[AnsibleRun] ${namespace}/${runName} failed to start queued shard(s)`, err);
    }
  }

  const allTerminal = updated.every((s) => s.phase && TERMINAL_SHARD_PHASES.has(s.phase));
  if (allTerminal) {
    const firstFailed = updated.find((s) => s.phase !== 'Succeeded');
    await patchRunStatus(client, descriptor, obj, {
      phase: firstFailed ? 'Failed' : 'Succeeded',
      completionTime: new Date().toISOString(),
      failedStep: firstFailed?.failedStep,
      shards: updated,
    });
    return;
  }

  if (changed) {
    await patchRunStatus(client, descriptor, obj, { shards: updated });
  }
  return { requeueAfterMs: 5000 };
}
