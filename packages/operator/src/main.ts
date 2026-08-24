import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { CustomResourceClient } from '@a5e/k8s-client';
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
  ClusterAnsibleSSHKeySpec,
  CustomResource,
} from '@a5e/schemas';
import { reconcileAnsibleJobs } from './controllers/ansiblejob-controller';
import { reconcileHost } from './controllers/host-controller';
import { reconcileInventory } from './controllers/inventory-controller';
import { reconcilePlaybook } from './controllers/playbook-controller';
import { reconcileRun } from './controllers/run-controller';
import { reconcileSSHKey } from './controllers/sshkey-controller';
import { createKubeConfig } from './k8s/client';
import { CoreResources } from './k8s/core';
import { CronTicker } from './k8s/cron-ticker';
import { type Controller, ResourceController } from './k8s/informer';
import { runWithLeaderElection } from './k8s/leader-election';
import { resolveGlobalS3Config } from './s3/uploader';

async function startControllers(): Promise<Controller[]> {
  const kc = createKubeConfig();
  const client = new CustomResourceClient(kc);
  const core = new CoreResources(kc);

  const controllers: Controller[] = [];

  // Host: identical reconcile logic registered against both scope variants (plan §3.1).
  for (const kind of ['AnsibleHost', 'ClusterAnsibleHost'] as const) {
    const descriptor = RESOURCE_DESCRIPTORS_BY_KIND[kind]!;
    controllers.push(
      new ResourceController<AnsibleHostSpec, AnsibleHostStatus>(kc, client, descriptor, (obj) =>
        reconcileHost(client, descriptor, obj),
      ),
    );
  }

  // SSH key.
  for (const kind of ['AnsibleSSHKey', 'ClusterAnsibleSSHKey'] as const) {
    const descriptor = RESOURCE_DESCRIPTORS_BY_KIND[kind]!;
    controllers.push(
      new ResourceController<AnsibleSSHKeySpec | ClusterAnsibleSSHKeySpec, AnsibleSSHKeyStatus>(
        kc,
        client,
        descriptor,
        (obj) => reconcileSSHKey(client, core, descriptor, obj),
      ),
    );
  }

  // Playbook.
  for (const kind of ['AnsiblePlaybook', 'ClusterAnsiblePlaybook'] as const) {
    const descriptor = RESOURCE_DESCRIPTORS_BY_KIND[kind]!;
    controllers.push(
      new ResourceController<AnsiblePlaybookSpec, AnsiblePlaybookStatus>(
        kc,
        client,
        descriptor,
        (obj) => reconcilePlaybook(client, core, descriptor, obj),
      ),
    );
  }

  // Inventory.
  for (const kind of ['AnsibleInventory', 'ClusterAnsibleInventory'] as const) {
    const descriptor = RESOURCE_DESCRIPTORS_BY_KIND[kind]!;
    controllers.push(
      new ResourceController<AnsibleInventorySpec, AnsibleInventoryStatus>(
        kc,
        client,
        descriptor,
        (obj) => reconcileInventory(client, descriptor, obj),
      ),
    );
  }

  // AnsibleRun: namespaced only, no Cluster-scoped counterpart.
  const runnerImage = process.env.RUNNER_IMAGE ?? 'a5e-runner:dev';
  const s3Config = resolveGlobalS3Config();
  if (!s3Config) {
    console.log(
      'no global S3 config found (S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY) — run logs stay pod-only',
    );
  }
  {
    const descriptor = RESOURCE_DESCRIPTORS_BY_KIND.AnsibleRun!;
    controllers.push(
      new ResourceController<AnsibleRunSpec, AnsibleRunStatus>(kc, client, descriptor, (obj) =>
        reconcileRun(client, core, descriptor, runnerImage, s3Config, obj),
      ),
    );
  }

  // AnsibleJob: ticked on a fixed interval rather than the event-driven workqueue every other
  // kind uses above — a cron schedule needs re-evaluating as time passes, not just when the
  // AnsibleJob object itself changes (see CronTicker's own comment).
  {
    const descriptor = RESOURCE_DESCRIPTORS_BY_KIND.AnsibleJob!;
    controllers.push(
      new CronTicker(client, descriptor, (obj) =>
        reconcileAnsibleJobs(
          client,
          descriptor,
          obj as CustomResource<AnsibleJobSpec, AnsibleJobStatus>,
        ),
      ),
    );
  }

  for (const controller of controllers) {
    await controller.start();
  }
  console.log(`operator started, watching ${controllers.length} resource kinds`);
  return controllers;
}

async function main() {
  let controllers: Controller[] = [];
  const shutdown = () => {
    console.log('shutting down...');
    for (const controller of controllers) controller.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  const kc = createKubeConfig();
  await runWithLeaderElection(
    kc,
    {
      leaseName: 'a5e-operator',
      namespace: process.env.POD_NAMESPACE ?? 'default',
      identity: process.env.POD_NAME ?? `${hostname()}-${randomUUID().slice(0, 8)}`,
    },
    async () => {
      controllers = await startControllers();
    },
  );
}

main().catch((err) => {
  console.error('operator failed to start', err);
  process.exit(1);
});
