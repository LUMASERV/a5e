import * as k8s from '@kubernetes/client-node';
import { fetch as undiciFetch } from 'undici';
import type { CallerIdentity } from './customResourceClient';

export interface PodLogOptions {
  follow?: boolean;
  tailLines?: number;
}

/**
 * Streams a pod's logs impersonated as `identity` — mirrors watch.ts's raw-fetch pattern for the
 * exact same reason: `@kubernetes/client-node`'s `Log` helper class has no hook for extra
 * headers, so it always authenticates as this process's own identity rather than the logged-in
 * user, which would silently bypass per-resource `pods/log` RBAC (see auth/authorize.ts — real
 * Kubernetes RBAC is meant to be the final authorization backstop for every k8s call this API
 * makes on a user's behalf, not just CRD CRUD).
 */
export async function streamPodLog(
  kc: k8s.KubeConfig,
  namespace: string,
  podName: string,
  container: string,
  identity: CallerIdentity,
  options: PodLogOptions,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const cluster = kc.getCurrentCluster();
  if (!cluster) throw new Error('No currently active cluster');

  const url = new URL(`${cluster.server}/api/v1/namespaces/${namespace}/pods/${podName}/log`);
  url.searchParams.set('container', container);
  if (options.follow) url.searchParams.set('follow', 'true');
  if (options.tailLines !== undefined) url.searchParams.set('tailLines', String(options.tailLines));

  const ctx = new k8s.RequestContext(url.toString(), k8s.HttpMethod.GET);
  await kc.applySecurityAuthentication(ctx);
  if (identity !== 'self') {
    ctx.setHeaderParam('Impersonate-User', identity.impersonateUser);
    if (identity.impersonateGroups?.[0]) {
      ctx.setHeaderParam('Impersonate-Group', identity.impersonateGroups[0]);
    }
  }

  const response = await undiciFetch(url, {
    method: 'GET',
    // biome-ignore lint/suspicious/noExplicitAny: undici's Headers type vs. client-node's plain Record
    headers: ctx.getHeaders() as any,
    dispatcher: ctx.getDispatcher(),
    signal,
  });

  if (response.status !== 200 || !response.body) {
    const error = new Error(response.statusText || 'log request failed') as Error & { statusCode?: number };
    error.statusCode = response.status;
    throw error;
  }
  return response.body;
}
