import * as k8s from '@kubernetes/client-node';

/**
 * Thin wrapper over the built-in-resource APIs the operator needs beyond the CRDs themselves
 * (Secrets, ConfigMaps, Jobs, Pods/pod logs). Always acts as the operator's own identity — no
 * impersonation, unlike the API's CustomResourceClient usage.
 */
export class CoreResources {
  private readonly core: k8s.CoreV1Api;
  private readonly batch: k8s.BatchV1Api;

  constructor(kc: k8s.KubeConfig) {
    this.core = kc.makeApiClient(k8s.CoreV1Api);
    this.batch = kc.makeApiClient(k8s.BatchV1Api);
  }

  async getSecret(namespace: string, name: string): Promise<k8s.V1Secret> {
    return this.core.readNamespacedSecret({ name, namespace });
  }

  async getConfigMap(namespace: string, name: string): Promise<k8s.V1ConfigMap> {
    return this.core.readNamespacedConfigMap({ name, namespace });
  }

  async createOrUpdateSecret(namespace: string, secret: k8s.V1Secret): Promise<k8s.V1Secret> {
    const name = secret.metadata?.name;
    if (!name) throw new Error('secret.metadata.name is required');
    try {
      return await this.core.createNamespacedSecret({ namespace, body: secret });
    } catch (err) {
      if ((err as { code?: number }).code !== 409) throw err;
      return this.core.replaceNamespacedSecret({ name, namespace, body: secret });
    }
  }

  async createOrUpdateConfigMap(namespace: string, configMap: k8s.V1ConfigMap): Promise<k8s.V1ConfigMap> {
    const name = configMap.metadata?.name;
    if (!name) throw new Error('configMap.metadata.name is required');
    try {
      return await this.core.createNamespacedConfigMap({ namespace, body: configMap });
    } catch (err) {
      if ((err as { code?: number }).code !== 409) throw err;
      return this.core.replaceNamespacedConfigMap({ name, namespace, body: configMap });
    }
  }

  async createJob(namespace: string, job: k8s.V1Job): Promise<k8s.V1Job> {
    try {
      return await this.batch.createNamespacedJob({ namespace, body: job });
    } catch (err) {
      if ((err as { code?: number }).code === 409 && job.metadata?.name) {
        return this.batch.readNamespacedJob({ name: job.metadata.name, namespace });
      }
      throw err;
    }
  }

  async getJob(namespace: string, name: string): Promise<k8s.V1Job> {
    return this.batch.readNamespacedJob({ name, namespace });
  }

  async patchJob(namespace: string, name: string, body: unknown): Promise<k8s.V1Job> {
    return this.batch.patchNamespacedJob(
      { name, namespace, body },
      k8s.setHeaderOptions('Content-Type', 'application/merge-patch+json'),
    );
  }

  async deleteJob(namespace: string, name: string): Promise<void> {
    await this.batch.deleteNamespacedJob({
      name,
      namespace,
      propagationPolicy: 'Foreground',
    });
  }

  async listPodsForJob(namespace: string, jobName: string): Promise<k8s.V1Pod[]> {
    const result = await this.core.listNamespacedPod({
      namespace,
      labelSelector: `job-name=${jobName}`,
    });
    return result.items;
  }

  /** Full (non-streaming) pod log capture — used post-completion, not for live-follow. */
  async getPodLog(namespace: string, podName: string, container: string): Promise<string> {
    return this.core.readNamespacedPodLog({ name: podName, namespace, container, timestamps: true });
  }
}
