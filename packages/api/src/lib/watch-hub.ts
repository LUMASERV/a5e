import {
  type CustomResourceClient,
  type WatchEvent,
  allNamespacesPath,
  resourcePath,
  watchReconnecting,
} from '@a5e/k8s-client';
import type { CustomResource, ResourceDescriptor } from '@a5e/schemas';
import type * as k8s from '@kubernetes/client-node';

type Obj = CustomResource<unknown, unknown>;

interface Subscriber {
  filter: (obj: Obj) => boolean;
  onEvent: (event: WatchEvent<Obj>) => void;
}

interface HubEntry {
  subscribers: Set<Subscriber>;
  watchHandle: ReturnType<typeof watchReconnecting> | null;
}

/**
 * Multiplexes SSE subscribers onto a single underlying k8s watch per (descriptor, namespace)
 * combination. Every upstream watch goes out as the API's own identity (`'self'`) now that k8s
 * RBAC/impersonation no longer decides authorization (see auth/permission-engine.ts) — it's
 * therefore broad/unfiltered by design, and each subscriber applies its OWN `filter` predicate
 * (built from that connection's effective permissions, snapshotted at subscribe time) before an
 * event is ever relayed down its SSE stream. This is a real efficiency win over the old
 * per-identity keying: many users watching the same kind/namespace now share exactly one upstream
 * k8s watch regardless of their individual permission scopes.
 */
export class WatchHub {
  private hubs = new Map<string, HubEntry>();

  constructor(
    private readonly kc: k8s.KubeConfig,
    private readonly client: CustomResourceClient,
  ) {}

  async subscribe(
    descriptor: ResourceDescriptor,
    namespace: string | undefined,
    filter: (obj: Obj) => boolean,
    onEvent: (event: WatchEvent<Obj>) => void,
  ): Promise<{ unsubscribe: () => void }> {
    const key = `${descriptor.kind}/${namespace ?? ''}`;
    let hub = this.hubs.get(key);

    if (!hub) {
      const isAllNamespaces = descriptor.scope === 'Namespaced' && !namespace;
      // No labelSelector here — the upstream watch must see everything; filtering moves downstream
      // to each subscriber's own `filter` predicate.
      const result = isAllNamespaces
        ? await this.client.listAllNamespaces<Obj>(descriptor, 'self')
        : await this.client.list<Obj>(descriptor, 'self', namespace);

      hub = { subscribers: new Set(), watchHandle: null };
      this.hubs.set(key, hub);

      const path =
        descriptor.scope === 'Namespaced'
          ? namespace
            ? resourcePath(descriptor, namespace)
            : allNamespacesPath(descriptor)
          : resourcePath(descriptor);

      hub.watchHandle = watchReconnecting<Obj>(
        this.kc,
        path,
        result.resourceVersion,
        'self',
        (event) => {
          for (const subscriber of hub!.subscribers) {
            if (subscriber.filter(event.object)) subscriber.onEvent(event);
          }
        },
        {
          onExpired: () => {
            // A relist-from-scratch is the caller's job on the next fresh subscribe; existing
            // subscribers just see a gap here, acceptable for a first cut (plan risk-accepted).
            console.warn(
              `[WatchHub] ${key}: resourceVersion expired (410), watch restarting fresh`,
            );
          },
          onError: (err) => console.error(`[WatchHub] ${key} watch error`, err),
        },
      );
    }

    const subscriber: Subscriber = { filter, onEvent };
    hub.subscribers.add(subscriber);
    const capturedHub = hub;
    return {
      unsubscribe: () => {
        capturedHub.subscribers.delete(subscriber);
        if (capturedHub.subscribers.size === 0) {
          capturedHub.watchHandle?.stop();
          this.hubs.delete(key);
        }
      },
    };
  }
}
