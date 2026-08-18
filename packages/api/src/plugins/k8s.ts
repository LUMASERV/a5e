import * as k8s from '@kubernetes/client-node';
import { setHeaderOptions } from '@kubernetes/client-node';
import { CustomResourceClient, loadKubeConfig, loadKubeConfigFromToken } from '@a5e/k8s-client';
import type { CallerIdentity } from '@a5e/k8s-client';

/**
 * Local dev against OrbStack's default kubeconfig (mTLS) doesn't work under Bun (see
 * packages/k8s-client/src/bootstrap.ts) — set API_KUBE_TOKEN/API_KUBE_SERVER/API_KUBE_CA_FILE
 * to use token-based auth instead (see scripts/seed-fixtures.ts). In-cluster deployment never
 * needs this: it always authenticates via the mounted ServiceAccount token already.
 */
function createKubeConfig(): k8s.KubeConfig {
  if (process.env.API_KUBE_TOKEN && process.env.API_KUBE_SERVER) {
    return loadKubeConfigFromToken({
      server: process.env.API_KUBE_SERVER,
      token: process.env.API_KUBE_TOKEN,
      caFile: process.env.API_KUBE_CA_FILE,
    });
  }
  return loadKubeConfig({ mode: process.env.KUBERNETES_SERVICE_HOST ? 'in-cluster' : 'kubeconfig' });
}

export const kc = createKubeConfig();
export const client = new CustomResourceClient(kc);
export const coreApi = kc.makeApiClient(k8s.CoreV1Api);
export const authnApi = kc.makeApiClient(k8s.AuthorizationV1Api);

/** Same impersonation-header pattern as CustomResourceClient, for the handful of built-in-resource calls the API makes directly (namespaces, pod logs). */
export function impersonatedOptions(identity: CallerIdentity) {
  if (identity === 'self') return {};
  let opts = setHeaderOptions('Impersonate-User', identity.impersonateUser);
  if (identity.impersonateGroups?.[0]) {
    opts = setHeaderOptions('Impersonate-Group', identity.impersonateGroups[0], opts);
  }
  return opts;
}
