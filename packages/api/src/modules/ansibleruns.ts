import { streamPodLog } from '@a5e/k8s-client';
import { API_GROUP_VERSION, RESOURCE_DESCRIPTORS_BY_KIND } from '@a5e/schemas';
import type { AnsibleRunSpec, AnsibleRunStatus, CustomResource } from '@a5e/schemas';
import * as k8s from '@kubernetes/client-node';
import { authorize } from '../auth/authorize';
import { canAct, resolveEffectivePermissions } from '../auth/permission-engine';
import { extractBearerToken } from '../auth/session';
import type { AnyElysia } from '../lib/elysia-types';
import { resolveGlobalS3Config } from '../lib/s3-status';
import { sseResponse } from '../lib/sse';
import { client, kc } from '../plugins/k8s';

function s3Client(): Bun.S3Client {
  const config = resolveGlobalS3Config();
  if (!config) throw new Error('S3 is not configured');
  return new Bun.S3Client({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    bucket: config.bucket,
    endpoint: config.endpoint,
    region: config.region ?? 'us-east-1',
  });
}

const descriptor = RESOURCE_DESCRIPTORS_BY_KIND.AnsibleRun!;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strips a trailing "-retry-N" so retrying a retry increments the same series instead of nesting suffixes. */
function baseRunName(name: string): string {
  return name.replace(/-retry-\d+$/, '');
}

export function registerAnsibleRunRoutes(app: AnyElysia): AnyElysia {
  return app
    .post(
      '/api/v1/namespaces/:namespace/ansibleruns/:name/cancel',
      async ({ params, headers, set }) => {
        const auth = await authorize(extractBearerToken(headers), 'user');
        if (auth instanceof Response) return auth;
        const run = await client.get<CustomResource<AnsibleRunSpec, AnsibleRunStatus>>(
          descriptor,
          params.name,
          'self',
          params.namespace,
        );
        const perms = await resolveEffectivePermissions(auth.session, auth.role);
        if (
          !canAct(
            perms,
            { type: 'AnsibleRun', namespace: params.namespace, labels: run.metadata.labels },
            'cancel',
          )
        ) {
          set.status = 403;
          return {
            error: 'forbidden',
            type: 'AnsibleRun',
            namespace: params.namespace,
            action: 'cancel',
          };
        }
        return client.patch(
          descriptor,
          params.name,
          { spec: { cancel: true } },
          'self',
          params.namespace,
        );
      },
    )

    .post(
      '/api/v1/namespaces/:namespace/ansibleruns/:name/retry',
      async ({ params, headers, set }) => {
        const auth = await authorize(extractBearerToken(headers), 'user');
        if (auth instanceof Response) return auth;
        const original = await client.get<CustomResource<AnsibleRunSpec, AnsibleRunStatus>>(
          descriptor,
          params.name,
          'self',
          params.namespace,
        );
        const perms = await resolveEffectivePermissions(auth.session, auth.role);
        if (
          !canAct(
            perms,
            { type: 'AnsibleRun', namespace: params.namespace, labels: original.metadata.labels },
            'retry',
          )
        ) {
          set.status = 403;
          return {
            error: 'forbidden',
            type: 'AnsibleRun',
            namespace: params.namespace,
            action: 'retry',
          };
        }

        // "<base>-retry-2", "<base>-retry-3", ... — retrying an already-retried run increments the
        // same series (via baseRunName) instead of nesting suffixes; the next number is derived
        // from whatever retries already exist, not just the one being retried, so retrying an
        // older run in the series doesn't collide with a later one.
        const base = baseRunName(params.name);
        const existing = await client.list<CustomResource<AnsibleRunSpec, AnsibleRunStatus>>(
          descriptor,
          'self',
          params.namespace,
        );
        const retryPattern = new RegExp(`^${escapeRegExp(base)}-retry-(\\d+)$`);
        let maxRetry = 1;
        for (const item of existing.items) {
          const match = item.metadata.name.match(retryPattern);
          if (match) maxRetry = Math.max(maxRetry, Number(match[1]));
        }
        const name = `${base}-retry-${maxRetry + 1}`;

        set.status = 201;
        return client.create(
          descriptor,
          {
            apiVersion: API_GROUP_VERSION,
            kind: 'AnsibleRun',
            metadata: { name, namespace: params.namespace },
            spec: { ...original.spec, cancel: false },
          },
          'self',
          params.namespace,
        );
      },
    )

    .get(
      '/api/v1/namespaces/:namespace/ansibleruns/:name/logs',
      async ({ params, headers, request, set }) => {
        const auth = await authorize(extractBearerToken(headers), 'user');
        if (auth instanceof Response) return auth;

        const run = await client.get<CustomResource<AnsibleRunSpec, AnsibleRunStatus>>(
          descriptor,
          params.name,
          'self',
          params.namespace,
        );
        const perms = await resolveEffectivePermissions(auth.session, auth.role);
        if (
          !canAct(
            perms,
            { type: 'AnsibleRun', namespace: params.namespace, labels: run.metadata.labels },
            'get',
          )
        ) {
          set.status = 403;
          return {
            error: 'forbidden',
            type: 'AnsibleRun',
            namespace: params.namespace,
            action: 'get',
          };
        }

        return sseResponse(request.signal, async (send) => {
          const logs = run.status?.logs;

          if (logs?.s3) {
            try {
              const text = await s3Client().file(logs.s3.key).text();
              send('log', text);
            } catch (err) {
              send('error', `failed to read archived log: ${(err as Error).message}`);
            }
            return () => undefined;
          }

          if (logs?.podRef) {
            const follow = run.status?.phase === 'Running' || run.status?.phase === 'Resolving';
            try {
              const body = await streamPodLog(
                kc,
                params.namespace,
                logs.podRef.name,
                logs.podRef.container,
                'self',
                { follow, tailLines: 500 },
                request.signal,
              );
              const reader = body.getReader();
              // Not awaited: pumps in the background while `subscribe` returns its cleanup function
              // immediately, matching how the previous k8s.Log-based version behaved (it also kicked
              // off streaming asynchronously rather than blocking until the stream ended).
              (async () => {
                try {
                  const decoder = new TextDecoder();
                  let buffer = '';
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const parts = buffer.split('\n');
                    buffer = parts.pop() ?? '';
                    for (const line of parts) {
                      if (line.length > 0) send('log', line);
                    }
                  }
                  if (buffer.length > 0) send('log', buffer);
                } catch (err) {
                  if (!request.signal.aborted)
                    send('error', `log stream error: ${(err as Error).message}`);
                }
              })();
              return () => {
                reader.cancel().catch(() => undefined);
              };
            } catch (err) {
              send('error', `failed to read pod logs: ${(err as Error).message}`);
              return () => undefined;
            }
          }

          send('error', 'no logs available for this run yet');
          return () => undefined;
        });
      },
    )

    .get(
      '/api/v1/namespaces/:namespace/ansibleruns/:name/logs/download',
      async ({ params, headers, set, redirect }) => {
        const auth = await authorize(extractBearerToken(headers), 'user');
        if (auth instanceof Response) return auth;
        const run = await client.get<CustomResource<AnsibleRunSpec, AnsibleRunStatus>>(
          descriptor,
          params.name,
          'self',
          params.namespace,
        );
        const perms = await resolveEffectivePermissions(auth.session, auth.role);
        if (
          !canAct(
            perms,
            { type: 'AnsibleRun', namespace: params.namespace, labels: run.metadata.labels },
            'get',
          )
        ) {
          set.status = 403;
          return {
            error: 'forbidden',
            type: 'AnsibleRun',
            namespace: params.namespace,
            action: 'get',
          };
        }
        const logs = run.status?.logs;

        if (logs?.s3) {
          const url = s3Client().file(logs.s3.key).presign({ expiresIn: 300 });
          return redirect(url, 302);
        }

        if (logs?.podRef) {
          const coreApi = kc.makeApiClient(k8s.CoreV1Api);
          const text = await coreApi.readNamespacedPodLog({
            name: logs.podRef.name,
            namespace: params.namespace,
            container: logs.podRef.container,
          });
          set.headers['content-type'] = 'text/plain';
          set.headers['content-disposition'] = `attachment; filename="${params.name}.log"`;
          return text;
        }

        set.status = 404;
        return { error: 'no logs available for this run yet' };
      },
    );
}
