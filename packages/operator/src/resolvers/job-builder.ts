import { API_GROUP, API_GROUP_VERSION } from '@a5e/schemas';
import type { AnsibleOptions } from '@a5e/schemas';
import type * as k8s from '@kubernetes/client-node';

export interface GitSource {
  url: string;
  revision?: string;
  /** Secret with an `ssh-privatekey` key — for `git@host:...`/`ssh://` URLs. At most one of this and basicAuthSecretName is ever set (CEL-enforced). */
  sshKeySecretName?: string;
  /** Secret with `username`/`password` keys — for `https://` URLs. */
  basicAuthSecretName?: string;
}

/** One distinct SSH key secret used by at least one host in this run's inventory — deduplicated by the controller so hosts sharing a key don't get redundant Secret copies/volumes. */
export interface SshKeyMount {
  /** Matches `ResolvedHost.sshKeyMountName` / the `ansible_ssh_private_key_file` path rendered into the inventory. */
  mountName: string;
  secretName: string;
}

export interface JobBuildInput {
  runName: string;
  runUid: string;
  namespace: string;
  runnerImage: string;
  /** Appended to the Job/pod name (`ansiblerun-<runName>[-<nameSuffix>]`) and, when set, recorded
   * as the `<API_GROUP>/run-shard` pod label — set to the shard index for a `parallel`-enabled
   * run's per-shard Jobs, omitted for a non-parallel run's single Job. */
  nameSuffix?: string;
  inventoryConfigMapName: string;
  /** Set when the playbook source is `inline`/`configMapRef` — mounted at /config. */
  playbookConfigMapName?: string;
  /** Set when the playbook source is `git` — cloned by the fetch-content init container. */
  gitSource?: GitSource;
  /** Relative path within the git repo (source.git.path), or unused for inline/configMapRef. */
  playbookPath?: string;
  entryPoint: string;
  hasDependencies: boolean;
  requirementsConfigMapName?: string;
  extraVarsConfigMapName: string;
  /** SSH keys live on hosts, not the run (plan: different hosts commonly need different keys) — one mount per distinct key actually used across the resolved inventory. */
  sshKeyMounts: SshKeyMount[];
  ansibleOptions?: AnsibleOptions;
  timeoutSeconds?: number;
  serviceAccountName?: string;
  resources?: k8s.V1ResourceRequirements;
}

const RUN_LABEL = `${API_GROUP}/run`;
const RUN_UID_LABEL = `${API_GROUP}/run-uid`;
const RUN_SHARD_LABEL = `${API_GROUP}/run-shard`;

function ansibleExtraArgs(options: AnsibleOptions | undefined): string {
  if (!options) return '';
  const args: string[] = [];
  if (options.verbosity) args.push(`-${'v'.repeat(options.verbosity)}`);
  if (options.checkMode) args.push('--check');
  if (options.limit) args.push('--limit', options.limit);
  if (options.forks) args.push('--forks', String(options.forks));
  for (const tag of options.tags ?? []) args.push('--tags', tag);
  for (const tag of options.skipTags ?? []) args.push('--skip-tags', tag);
  return args.join(' ');
}

/**
 * Pure function: resolved run inputs -> a Kubernetes Job spec. No k8s calls — the controller
 * gathers everything this needs (ConfigMap names it already created, ssh key secret ref, etc.)
 * beforehand, keeping this unit-testable in isolation (plan §3.4/§4 "Critical Files").
 *
 * Strict 1:1 Run:Job:Pod mapping: `backoffLimit: 0`, `restartPolicy: Never` — ansible-playbook
 * isn't safely blindly-retryable, so a "retry" is a new AnsibleRun, never an automatic Job retry.
 */
export function buildJobSpec(input: JobBuildInput): k8s.V1Job {
  const initContainers: k8s.V1Container[] = [];
  const volumes: k8s.V1Volume[] = [
    { name: 'workspace', emptyDir: {} },
    { name: 'inventory', configMap: { name: input.inventoryConfigMapName } },
    { name: 'extra-vars', configMap: { name: input.extraVarsConfigMapName } },
  ];
  const mainVolumeMounts: k8s.V1VolumeMount[] = [
    { name: 'workspace', mountPath: '/workspace' },
    { name: 'inventory', mountPath: '/inventory', readOnly: true },
    { name: 'extra-vars', mountPath: '/extra-vars', readOnly: true },
  ];
  for (const mount of input.sshKeyMounts) {
    const volumeName = `ssh-key-${mount.mountName}`;
    volumes.push({
      name: volumeName,
      secret: { secretName: mount.secretName, defaultMode: 0o640 },
    });
    mainVolumeMounts.push({
      name: volumeName,
      mountPath: `/ssh-keys/${mount.mountName}`,
      readOnly: true,
    });
  }

  let playbookDir: string;
  if (input.gitSource) {
    const gitEnv: k8s.V1EnvVar[] = [
      { name: 'GIT_URL', value: input.gitSource.url },
      { name: 'GIT_REVISION', value: input.gitSource.revision ?? 'main' },
    ];
    const gitVolumeMounts: k8s.V1VolumeMount[] = [{ name: 'workspace', mountPath: '/workspace' }];

    if (input.gitSource.sshKeySecretName) {
      volumes.push({
        name: 'git-ssh-key',
        secret: { secretName: input.gitSource.sshKeySecretName, defaultMode: 0o640 },
      });
      gitEnv.push({ name: 'GIT_SSH_KEY_PATH', value: '/git-ssh-key/ssh-privatekey' });
      gitVolumeMounts.push({ name: 'git-ssh-key', mountPath: '/git-ssh-key', readOnly: true });
    } else if (input.gitSource.basicAuthSecretName) {
      volumes.push({
        name: 'git-basic-auth',
        secret: { secretName: input.gitSource.basicAuthSecretName, defaultMode: 0o640 },
      });
      gitEnv.push({ name: 'GIT_HTTP_AUTH_PATH', value: '/git-basic-auth' });
      gitVolumeMounts.push({
        name: 'git-basic-auth',
        mountPath: '/git-basic-auth',
        readOnly: true,
      });
    }

    initContainers.push({
      name: 'fetch-content',
      image: input.runnerImage,
      args: ['fetch-content'],
      env: gitEnv,
      volumeMounts: gitVolumeMounts,
      terminationMessagePolicy: 'FallbackToLogsOnError',
    });
    playbookDir = `/workspace/repo${input.playbookPath ? `/${input.playbookPath}` : ''}`;
  } else {
    volumes.push({ name: 'playbook', configMap: { name: input.playbookConfigMapName! } });
    mainVolumeMounts.push({ name: 'playbook', mountPath: '/config', readOnly: true });
    playbookDir = '/config';
  }

  if (input.hasDependencies) {
    volumes.push({ name: 'requirements', configMap: { name: input.requirementsConfigMapName! } });
    initContainers.push({
      name: 'install-dependencies',
      image: input.runnerImage,
      args: ['install-dependencies'],
      env: [{ name: 'REQUIREMENTS_FILE', value: '/requirements/requirements.yml' }],
      volumeMounts: [
        { name: 'workspace', mountPath: '/workspace' },
        { name: 'requirements', mountPath: '/requirements', readOnly: true },
      ],
      terminationMessagePolicy: 'FallbackToLogsOnError',
    });
  }

  const podLabels = {
    [RUN_LABEL]: input.runName,
    [RUN_UID_LABEL]: input.runUid,
    ...(input.nameSuffix !== undefined ? { [RUN_SHARD_LABEL]: input.nameSuffix } : {}),
  };
  const jobName = `ansiblerun-${input.runName}${input.nameSuffix !== undefined ? `-${input.nameSuffix}` : ''}`;

  const job: k8s.V1Job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace: input.namespace,
      labels: podLabels,
      ownerReferences: [
        {
          apiVersion: API_GROUP_VERSION,
          kind: 'AnsibleRun',
          name: input.runName,
          uid: input.runUid,
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: input.timeoutSeconds,
      // A generous backstop TTL in case the operator is ever removed before it can set the
      // real TTL once log capture is confirmed (plan §3.4 step 3g) — 24h.
      ttlSecondsAfterFinished: 24 * 60 * 60,
      template: {
        metadata: { labels: podLabels },
        spec: {
          restartPolicy: 'Never',
          serviceAccountName: input.serviceAccountName,
          automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, runAsUser: 1000, fsGroup: 1000 },
          initContainers,
          containers: [
            {
              name: 'ansible-playbook',
              image: input.runnerImage,
              args: ['playbook'],
              env: [
                { name: 'PLAYBOOK_DIR', value: playbookDir },
                { name: 'ENTRY_POINT', value: input.entryPoint },
                { name: 'INVENTORY_FILE', value: '/inventory/inventory.ini' },
                { name: 'EXTRA_VARS_FILE', value: '/extra-vars/extra-vars.json' },
                { name: 'ANSIBLE_EXTRA_ARGS', value: ansibleExtraArgs(input.ansibleOptions) },
                // ansible-playbook disables color by default when stdout isn't a TTY (always
                // true here, captured via the k8s pod log API) — force it so the UI's log
                // viewer has ANSI codes to render.
                { name: 'ANSIBLE_FORCE_COLOR', value: 'true' },
              ],
              volumeMounts: mainVolumeMounts,
              resources: input.resources,
              terminationMessagePolicy: 'FallbackToLogsOnError',
            },
          ],
          volumes,
        },
      },
    },
  };

  return job;
}
