import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import * as k8s from '@kubernetes/client-node';
import { fetch as undiciFetch } from 'undici';
import type { CallerIdentity } from './customResourceClient';

export type WatchEventType = 'ADDED' | 'MODIFIED' | 'DELETED' | 'BOOKMARK' | 'ERROR';

export interface WatchEvent<T> {
  type: WatchEventType;
  object: T;
}

export interface ReconnectingWatchOptions {
  labelSelector?: string;
  /** Called once with the new resourceVersion whenever the server sends `410 Gone` — the caller must re-list and call `resume()` with the fresh resourceVersion. */
  onExpired?: () => void;
  /** Called on any other watch error, purely for logging — the watch reconnects regardless. */
  onError?: (err: unknown) => void;
}

export interface ReconnectingWatch {
  stop(): void;
  /** Restart the watch from a fresh resourceVersion (used after `onExpired` + a re-list). */
  resume(resourceVersion: string | undefined): void;
}

/**
 * `@kubernetes/client-node`'s own `Watch` class has no hook for extra headers — it builds
 * request auth solely via `KubeConfig.applySecurityAuthentication(ctx)`, with no equivalent of
 * the `middleware`/`ConfigurationOptions` mechanism the generated CRUD API classes accept. That
 * makes it unusable for impersonated calls (the API's every other k8s call goes out as the
 * logged-in user via Impersonate-* headers — see CustomResourceClient). This reimplements the
 * same request shape (confirmed working under Bun in the original spike: same `undici` fetch
 * import, same `RequestContext`/`applySecurityAuthentication` pattern) but layers the
 * impersonation headers on afterward via `RequestContext.setHeaderParam`, exactly like
 * `withImpersonation` does for the CRUD APIs.
 */
async function watchOnce<T>(
  kc: k8s.KubeConfig,
  path: string,
  queryParams: Record<string, string | boolean | undefined>,
  identity: CallerIdentity,
  onEvent: (type: string, object: T) => void,
  signal: AbortSignal,
): Promise<{ error?: unknown }> {
  const cluster = kc.getCurrentCluster();
  if (!cluster) throw new Error('No currently active cluster');

  const watchUrl = new URL(cluster.server + path);
  watchUrl.searchParams.set('watch', 'true');
  for (const [key, value] of Object.entries(queryParams)) {
    if (value !== undefined) watchUrl.searchParams.set(key, String(value));
  }

  const ctx = new k8s.RequestContext(watchUrl.toString(), k8s.HttpMethod.GET);
  await kc.applySecurityAuthentication(ctx);
  if (identity !== 'self') {
    ctx.setHeaderParam('Impersonate-User', identity.impersonateUser);
    if (identity.impersonateGroups?.[0]) {
      ctx.setHeaderParam('Impersonate-Group', identity.impersonateGroups[0]);
    }
  }

  const response = await undiciFetch(watchUrl, {
    method: 'GET',
    // biome-ignore lint/suspicious/noExplicitAny: undici's Headers type vs. client-node's plain Record
    headers: ctx.getHeaders() as any,
    dispatcher: ctx.getDispatcher(),
    signal,
  });

  if (response.status !== 200) {
    const error = new Error(response.statusText || 'watch request failed') as Error & {
      statusCode?: number;
    };
    error.statusCode = response.status;
    return { error };
  }

  return new Promise((resolve) => {
    let settled = false;
    const settle = (error?: unknown) => {
      if (settled) return;
      settled = true;
      resolve({ error });
    };

    // biome-ignore lint/suspicious/noExplicitAny: undici Response.body vs. node stream Readable typings
    const body = Readable.fromWeb(response.body as any);
    body.on('error', settle);
    body.on('close', () => settle());
    const lines = createInterface(body);
    lines.on('error', settle);
    lines.on('close', () => settle());
    lines.on('line', (line) => {
      try {
        const data = JSON.parse(line);
        onEvent(data.type, data.object);
      } catch {
        // ignore malformed lines
      }
    });
  });
}

/**
 * client-node v2's `Watch.watch()` enforces a hardcoded 30s request timeout and then ends
 * cleanly (no error) — this is normal per-request behavior of this client version, not a
 * dropped connection to treat as an anomaly. This wrapper transparently re-establishes the
 * watch every time the underlying request ends, continuing from the last-seen resourceVersion,
 * so callers see one logical, indefinitely-long watch stream.
 */
export function watchReconnecting<T extends { metadata?: { resourceVersion?: string } }>(
  kc: k8s.KubeConfig,
  path: string,
  initialResourceVersion: string | undefined,
  identity: CallerIdentity,
  onEvent: (event: WatchEvent<T>) => void,
  options: ReconnectingWatchOptions = {},
): ReconnectingWatch {
  let resourceVersion = initialResourceVersion;
  let stopped = false;
  let currentController: AbortController | null = null;

  async function runOneCycle(): Promise<void> {
    const controller = new AbortController();
    currentController = controller;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const { error } = await watchOnce<T>(
        kc,
        path,
        { resourceVersion, allowWatchBookmarks: true, labelSelector: options.labelSelector },
        identity,
        (type, object) => {
          if (object?.metadata?.resourceVersion) resourceVersion = object.metadata.resourceVersion;
          onEvent({ type: type as WatchEventType, object });
        },
        controller.signal,
      );
      if (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 410) {
          resourceVersion = undefined;
          options.onExpired?.();
        } else if (!controller.signal.aborted) {
          options.onError?.(error);
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) options.onError?.(err);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function loop() {
    while (!stopped) {
      await runOneCycle();
      if (!stopped) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  loop();

  return {
    stop() {
      stopped = true;
      currentController?.abort();
    },
    resume(newResourceVersion) {
      resourceVersion = newResourceVersion;
      currentController?.abort();
    },
  };
}
