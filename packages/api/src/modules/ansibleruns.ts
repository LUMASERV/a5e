import { streamPodLog } from '@a5e/k8s-client';
import { API_GROUP_VERSION, RESOURCE_DESCRIPTORS_BY_KIND } from '@a5e/schemas';
import type {
  AnsibleRunSpec,
  AnsibleRunStatus,
  CustomResource,
  RunShardStatus,
} from '@a5e/schemas';
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

/**
 * A `parallel`-enabled run has no single `status.logs`/`status.podName` — each shard carries its
 * own, mirroring the top-level fields (run-controller.ts's `pollShardJob`). `?shard=<index>`
 * selects one; omitted (or the run isn't parallel) falls back to the top-level fields, unchanged
 * from before shards existed.
 */
function selectRunLogs(
  run: CustomResource<AnsibleRunSpec, AnsibleRunStatus>,
  shardParam: string | undefined,
): { logs: AnsibleRunStatus['logs']; isActive: boolean } {
  if (shardParam !== undefined && run.status?.shards) {
    const shard = run.status.shards.find((s) => s.index === Number(shardParam));
    return { logs: shard?.logs, isActive: shard?.phase === 'Running' };
  }
  return {
    logs: run.status?.logs,
    isActive: run.status?.phase === 'Running' || run.status?.phase === 'Resolving',
  };
}

/** Strips a trailing "-retry-N" so retrying a retry increments the same series instead of nesting suffixes. */
function baseRunName(name: string): string {
  return name.replace(/-retry-\d+$/, '');
}

/**
 * Streams one shard's logs into a shared SSE `send`, each line tagged `[shard N]` so an
 * aggregated view (every shard interleaved into one stream — see the `/logs` route below, the
 * no-`?shard` case for a `parallel` run) stays attributable line-by-line. Mirrors the single-shard
 * podRef branch of the `/logs` route almost exactly; kept separate rather than parameterized
 * because the aggregated caller needs its own independent cleanup per shard, not one shared
 * early-return.
 */
async function streamShardLogsInto(
  namespace: string,
  shard: RunShardStatus,
  send: (event: string, data: unknown) => void,
  signal: AbortSignal,
): Promise<() => void> {
  const prefix = `[shard ${shard.index}]`;

  if (shard.logs?.s3) {
    try {
      const text = await s3Client().file(shard.logs.s3.key).text();
      for (const line of text.split('\n')) send('log', `${prefix} ${line}`);
    } catch (err) {
      send('error', `shard ${shard.index}: failed to read archived log: ${(err as Error).message}`);
    }
    return () => undefined;
  }

  if (shard.logs?.podRef) {
    const follow = shard.phase === 'Running';
    try {
      const body = await streamPodLog(
        kc,
        namespace,
        shard.logs.podRef.name,
        shard.logs.podRef.container,
        'self',
        { follow, tailLines: 500 },
        signal,
      );
      const reader = body.getReader();
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
              if (line.length > 0) send('log', `${prefix} ${line}`);
            }
          }
          if (buffer.length > 0) send('log', `${prefix} ${buffer}`);
        } catch (err) {
          if (!signal.aborted) {
            send('error', `shard ${shard.index}: log stream error: ${(err as Error).message}`);
          }
        }
      })();
      return () => {
        reader.cancel().catch(() => undefined);
      };
    } catch (err) {
      send('error', `shard ${shard.index}: failed to read pod logs: ${(err as Error).message}`);
      return () => undefined;
    }
  }

  return () => undefined; // shard has no logs yet (still Pending) — nothing to stream
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
      async ({ params, query, headers, request, set }) => {
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
          // No `?shard` on a `parallel` run: aggregate every shard's log into one stream instead
          // of falling back to the (nonexistent, for a parallel run) top-level logs — see
          // RunDetailView.vue's "All shards" selection.
          const shards = run.status?.shards;
          if (query.shard === undefined && shards?.length) {
            const cleanups = await Promise.all(
              shards.map((shard) =>
                streamShardLogsInto(params.namespace, shard, send, request.signal),
              ),
            );
            if (!shards.some((s) => s.logs)) {
              send('error', 'no logs available for this run yet');
            }
            return () => {
              for (const cleanup of cleanups) cleanup();
            };
          }

          const { logs, isActive } = selectRunLogs(run, query.shard);

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
            const follow = isActive;
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
      async ({ params, query, headers, set, redirect }) => {
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
        // No `?shard` on a `parallel` run: concatenate every shard's log into one file, each
        // under its own header — the streaming `/logs` route's aggregation has no equivalent
        // "redirect to a presigned S3 URL" shortcut once there's more than one source, so this
        // always reads shard content into memory rather than redirecting.
        const shards = run.status?.shards;
        if (query.shard === undefined && shards?.length) {
          const parts: string[] = [];
          for (const shard of shards) {
            const hosts = shard.hosts.length ? ` (${shard.hosts.join(', ')})` : '';
            const header = `==== shard ${shard.index}${hosts} ====`;
            if (shard.logs?.s3) {
              try {
                parts.push(`${header}\n${await s3Client().file(shard.logs.s3.key).text()}`);
              } catch (err) {
                parts.push(`${header}\n[failed to read archived log: ${(err as Error).message}]`);
              }
            } else if (shard.logs?.podRef) {
              try {
                const coreApi = kc.makeApiClient(k8s.CoreV1Api);
                const text = await coreApi.readNamespacedPodLog({
                  name: shard.logs.podRef.name,
                  namespace: params.namespace,
                  container: shard.logs.podRef.container,
                });
                parts.push(`${header}\n${text}`);
              } catch (err) {
                parts.push(`${header}\n[failed to read pod log: ${(err as Error).message}]`);
              }
            } else {
              parts.push(`${header}\n[no logs available yet]`);
            }
          }
          set.headers['content-type'] = 'text/plain';
          set.headers['content-disposition'] = `attachment; filename="${params.name}.log"`;
          return parts.join('\n\n');
        }

        const { logs } = selectRunLogs(run, query.shard);

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
          const suffix = query.shard !== undefined ? `-shard-${query.shard}` : '';
          set.headers['content-type'] = 'text/plain';
          set.headers['content-disposition'] = `attachment; filename="${params.name}${suffix}.log"`;
          return text;
        }

        set.status = 404;
        return { error: 'no logs available for this run yet' };
      },
    );
}
