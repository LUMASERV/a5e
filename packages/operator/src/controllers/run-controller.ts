import type * as k8s from '@kubernetes/client-node';
import { resolveInventoryGroups, resolveRefNamespace, type CustomResourceClient, type ResolvedGroup } from '@a5e/k8s-client';
import {
  API_GROUP_VERSION,
  RESOURCE_DESCRIPTORS_BY_KIND,
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
  type ResourceDescriptor,
} from '@a5e/schemas';
import type { ReconcileResult } from '../k8s/informer';
import type { CoreResources } from '../k8s/core';
import { resolveRef } from '../resolvers/object-ref';
import { renderInventoryIni } from '../resolvers/inventory-render';
import { buildRequirementsYaml } from '../resolvers/requirements-yaml';
import { buildJobSpec, type JobBuildInput, type SshKeyMount } from '../resolvers/job-builder';
import { type S3Config, uploadRunLog } from '../s3/uploader';

const TERMINAL_PHASES = new Set(['Succeeded', 'Failed', 'Error', 'Cancelled']);

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
  const merged: AnsibleRunStatus = { ...obj.status, ...patch, observedGeneration: obj.metadata.generation };
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
      const sshKeyNamespace = resolveRefNamespace(sshKeyDescriptor.scope, ref.namespace, host.namespace);
      const refKey = `${ref.kind}/${sshKeyNamespace ?? ''}/${ref.name}`;

      let mount = mountByRefKey.get(refKey);
      if (!mount) {
        const sshKeyObj = await client.get<CustomResource<AnsibleSSHKeySpec | ClusterAnsibleSSHKeySpec, AnsibleSSHKeyStatus>>(
          sshKeyDescriptor,
          ref.name,
          'self',
          sshKeyNamespace,
        );
        if (!sshKeyObj.status?.publicKey) {
          return { requeue: true }; // sshkey-controller hasn't derived it yet
        }

        // Same rule for the AnsibleSSHKey's OWN secretRef: a namespaced AnsibleSSHKey must never
        // be allowed to point at a Secret in a different namespace either (the actual step in the
        // exploit chain that let a copied Secret's raw key bytes reach the attacker's namespace).
        const sshKeyOwnNamespace = sshKeyDescriptor.scope === 'Namespaced' ? sshKeyObj.metadata.namespace : undefined;
        const sourceSecretNamespace = resolveRefNamespace('Namespaced', sshKeyObj.spec.secretRef.namespace, sshKeyOwnNamespace) ?? namespace;
        const sourceSecret = await core.getSecret(sourceSecretNamespace, sshKeyObj.spec.secretRef.name);
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
    throw new Error(`host(s) missing spec.sshKeyRef, required to connect over SSH: ${missingHosts.join(', ')}`);
  }

  return { requeue: false, mounts: [...mountByRefKey.values()] };
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
    await patchRunStatus(client, descriptor, obj, { phase: 'Cancelled', completionTime: new Date().toISOString() });
    return;
  }

  if (status.phase && TERMINAL_PHASES.has(status.phase)) {
    return; // done — logs were already finalized when the phase was set terminal (see pollRun)
  }

  if (status.phase === 'Running' && status.jobRef) {
    return pollRun(client, core, descriptor, s3Config, obj);
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

    const playbookObj = await resolveRef<AnsiblePlaybookSpec, unknown>(client, obj.spec.playbookRef, namespace);
    const inventoryObj = await resolveRef<AnsibleInventorySpec, unknown>(client, obj.spec.inventoryRef, namespace);

    const owner = ownerRef(obj);
    const namePrefix = `ansiblerun-${runName}`;

    // Inventory: resolve hosts + jump chains, then each host's own SSH key (plan: keys are a
    // host property, not a run property), then render + an operator-owned, owner-ref'd
    // ConfigMap — the immutable per-run snapshot, independent of later changes to
    // AnsibleInventory/AnsibleHost (plan §3.4 step 2e).
    // `inventoryObj.metadata.namespace` is already the resolved, validated namespace (or
    // `undefined` for a ClusterAnsibleInventory) — read it directly rather than recomputing from
    // `obj.spec.inventoryRef` a second time, so there's only one place (resolveRef, above) that
    // ever decides whether a cross-namespace inventoryRef was legitimate.
    const groups = await resolveInventoryGroups(client, 'self', inventoryObj.spec, inventoryObj.metadata.namespace, true);

    const sshKeyResult = await resolveHostSshKeys(client, core, namespace, namePrefix, owner, groups);
    if (sshKeyResult.requeue) {
      return { requeueAfterMs: 3000 }; // controller-ordering dependency — sshkey-controller hasn't derived it yet
    }
    const sshKeyMounts = sshKeyResult.mounts;

    const inventoryIni = renderInventoryIni(inventoryObj.spec.vars, groups);
    const inventoryCm = await core.createOrUpdateConfigMap(namespace, {
      metadata: { name: `${namePrefix}-inventory`, namespace, ownerReferences: [owner] },
      data: { 'inventory.ini': inventoryIni },
    });

    // Extra vars: playbook defaults, then the run's own overrides win.
    const mergedExtraVars = { ...(playbookObj.spec.extraVars ?? {}), ...(obj.spec.extraVars ?? {}) };
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
    const playbookOwnNamespace = playbookDescriptor.scope === 'Namespaced' ? playbookObj.metadata.namespace : undefined;

    if (playbookObj.spec.source.inline) {
      const cm = await core.createOrUpdateConfigMap(namespace, {
        metadata: { name: `${namePrefix}-playbook`, namespace, ownerReferences: [owner] },
        data: { [entryPoint]: playbookObj.spec.source.inline.playbook },
      });
      playbookConfigMapName = cm.metadata!.name!;
    } else if (playbookObj.spec.source.configMapRef) {
      const ref = playbookObj.spec.source.configMapRef;
      const refNamespace = resolveRefNamespace('Namespaced', ref.namespace, playbookOwnNamespace) ?? namespace;
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
        const secretNamespace = resolveRefNamespace('Namespaced', git.sshKeySecretRef.namespace, playbookOwnNamespace) ?? namespace;
        const sourceSecret = await core.getSecret(secretNamespace, git.sshKeySecretRef.name);
        sshKeySecretName = `${namePrefix}-git-sshkey`;
        await core.createOrUpdateSecret(namespace, {
          metadata: { name: sshKeySecretName, namespace, ownerReferences: [owner] },
          type: sourceSecret.type,
          data: sourceSecret.data,
        });
      } else if (git.basicAuthSecretRef) {
        const secretNamespace = resolveRefNamespace('Namespaced', git.basicAuthSecretRef.namespace, playbookOwnNamespace) ?? namespace;
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
      playbookObj.spec.dependencies?.roles?.length || playbookObj.spec.dependencies?.collections?.length,
    );
    let requirementsConfigMapName: string | undefined;
    if (hasDependencies) {
      const cm = await core.createOrUpdateConfigMap(namespace, {
        metadata: { name: `${namePrefix}-requirements`, namespace, ownerReferences: [owner] },
        data: { 'requirements.yml': buildRequirementsYaml(playbookObj.spec.dependencies!) },
      });
      requirementsConfigMapName = cm.metadata!.name!;
    }

    const jobSpec = buildJobSpec({
      runName,
      runUid: obj.metadata.uid!,
      namespace,
      runnerImage,
      inventoryConfigMapName: inventoryCm.metadata!.name!,
      playbookConfigMapName,
      gitSource,
      playbookPath,
      entryPoint,
      hasDependencies,
      requirementsConfigMapName,
      extraVarsConfigMapName: extraVarsCm.metadata!.name!,
      sshKeyMounts,
      ansibleOptions: obj.spec.ansibleOptions,
      timeoutSeconds: obj.spec.timeoutSeconds,
      serviceAccountName: obj.spec.serviceAccountName,
      resources: obj.spec.resources as k8s.V1ResourceRequirements | undefined,
    });

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
  return (pod.status?.containerStatuses ?? []).find((c) => c.name === 'ansible-playbook')?.state?.terminated
    ?.exitCode;
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

  let job: k8s.V1Job;
  try {
    job = await core.getJob(namespace, jobName);
  } catch (err) {
    await patchRunStatus(
      client,
      descriptor,
      obj,
      { phase: 'Error', completionTime: new Date().toISOString() },
      { reason: 'JobNotFound', message: (err as Error).message },
    );
    return;
  }

  const succeeded = (job.status?.succeeded ?? 0) > 0;
  const failed = (job.status?.failed ?? 0) > 0;
  if (!succeeded && !failed) {
    return { requeueAfterMs: 5000 }; // still running — plain re-poll, not an error/backoff case
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

  let logs: AnsibleRunStatus['logs'] = podName ? { podRef: { name: podName, container: 'ansible-playbook' } } : undefined;
  if (s3Config) {
    try {
      const key = `${namespace}/${obj.metadata.name}/log.txt`;
      const result = await uploadRunLog(s3Config, key, fullLogs);
      logs = {
        ...logs,
        s3: {
          bucket: s3Config.bucket,
          key,
          endpoint: s3Config.endpoint,
          sizeBytes: result.sizeBytes,
          uploadedAt: new Date().toISOString(),
        },
      };
    } catch (err) {
      console.error(`[AnsibleRun] ${namespace}/${obj.metadata.name} S3 log upload failed`, err);
    }
  }

  // Only shorten the Job's TTL once log capture is resolved (uploaded, or permanently given up
  // on) — this ordering is what protects logs from GC racing the upload (plan §3.4 step 3g).
  await core
    .patchJob(namespace, jobName, { spec: { ttlSecondsAfterFinished: obj.spec.ttlSecondsAfterFinished ?? 3600 } })
    .catch(() => undefined);

  await patchRunStatus(client, descriptor, obj, {
    phase: succeeded ? 'Succeeded' : 'Failed',
    completionTime: new Date().toISOString(),
    podName,
    exitCode,
    failedStep,
    logs,
  });
}
