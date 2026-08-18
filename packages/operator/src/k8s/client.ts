import * as k8s from '@kubernetes/client-node';
import { loadKubeConfig, loadKubeConfigFromToken } from '@a5e/k8s-client';

/**
 * Local dev against OrbStack's default kubeconfig (mTLS) doesn't work under Bun (see
 * packages/k8s-client/src/bootstrap.ts) — set OPERATOR_KUBE_TOKEN/OPERATOR_KUBE_SERVER/
 * OPERATOR_KUBE_CA_FILE (see scripts/seed-fixtures.ts, which provisions a ServiceAccount token
 * for exactly this) to use token-based auth instead. In-cluster deployment never needs this: it
 * always authenticates via the mounted ServiceAccount token already.
 */
export function createKubeConfig(): k8s.KubeConfig {
  if (process.env.OPERATOR_KUBE_TOKEN && process.env.OPERATOR_KUBE_SERVER) {
    return loadKubeConfigFromToken({
      server: process.env.OPERATOR_KUBE_SERVER,
      token: process.env.OPERATOR_KUBE_TOKEN,
      caFile: process.env.OPERATOR_KUBE_CA_FILE,
    });
  }
  return loadKubeConfig({ mode: process.env.KUBERNETES_SERVICE_HOST ? 'in-cluster' : 'kubeconfig' });
}
