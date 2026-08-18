import type * as k8s from '@kubernetes/client-node';
import {
  allNamespacesPath,
  type CallerIdentity,
  type CustomResourceClient,
  resourcePath,
  watchReconnecting,
  type WatchEvent,
} from '@a5e/k8s-client';
import type { CustomResource, ResourceDescriptor } from '@a5e/schemas';

function identityKey(identity: CallerIdentity): string {
  if (identity === 'self') return 'self';
  return `${identity.impersonateUser}|${(identity.impersonateGroups ?? []).join(',')}`;
}

interface HubEntry {
  subscribers: Set<(event: WatchEvent<CustomResource<unknown, unknown>>) => void>;
  watchHandle: ReturnType<typeof watchReconnecting> | null;
}

/**
 * Multiplexes SSE subscribers onto a single underlying k8s watch per (descriptor, namespace,
 * labelSelector) combination — but IMPORTANTLY also keyed by caller identity. A shared watch
 * established under one user's impersonated identity must never be reused for a different
 * user: RBAC is enforced by the k8s API server on the watch itself (impersonated per plan §4.4),
 * so sharing across identities would leak data a second user isn't authorized to see. Sharing
 * therefore only kicks in across multiple tabs/reconnects of the SAME logged-in user — still a
 * meaningful reduction in k8s-side watch count, just not a global one.
 */
export class WatchHub {
  private hubs = new Map<string, HubEntry>();

  constructor(
    private readonly kc: k8s.KubeConfig,
    private readonly client: CustomResourceClient,
  ) {}

  /** Returns an unsubscribe function. Also emits an initial synthetic snapshot via `onInitial`. */
  async subscribe(
    descriptor: ResourceDescriptor,
    identity: CallerIdentity,
    namespace: string | undefined,
    labelSelector: string | undefined,
    onEvent: (event: WatchEvent<CustomResource<unknown, unknown>>) => void,
  ): Promise<{ unsubscribe: () => void; initialResourceVersion: string | undefined }> {
    const key = `${identityKey(identity)}/${descriptor.kind}/${namespace ?? ''}/${labelSelector ?? ''}`;
    let hub = this.hubs.get(key);
    let initialResourceVersion: string | undefined;

    if (!hub) {
      const isAllNamespaces = descriptor.scope === 'Namespaced' && !namespace;
      const result = isAllNamespaces
        ? await this.client.listAllNamespaces<CustomResource<unknown, unknown>>(descriptor, identity, {
            labelSelector,
          })
        : await this.client.list<CustomResource<unknown, unknown>>(descriptor, identity, namespace, {
            labelSelector,
          });
      initialResourceVersion = result.resourceVersion;

      hub = { subscribers: new Set(), watchHandle: null };
      this.hubs.set(key, hub);

      const path =
        descriptor.scope === 'Namespaced'
          ? namespace
            ? resourcePath(descriptor, namespace)
            : allNamespacesPath(descriptor)
          : resourcePath(descriptor);

      hub.watchHandle = watchReconnecting<CustomResource<unknown, unknown>>(
        this.kc,
        path,
        result.resourceVersion,
        identity,
        (event) => {
          for (const subscriber of hub!.subscribers) subscriber(event);
        },
        {
          onExpired: () => {
            // A relist-from-scratch is the caller's job on the next fresh subscribe; existing
            // subscribers just see a gap here, acceptable for a first cut (plan risk-accepted).
            console.warn(`[WatchHub] ${key}: resourceVersion expired (410), watch restarting fresh`);
          },
          onError: (err) => console.error(`[WatchHub] ${key} watch error`, err),
        },
      );
    }

    hub.subscribers.add(onEvent);
    const capturedHub = hub;
    return {
      initialResourceVersion,
      unsubscribe: () => {
        capturedHub.subscribers.delete(onEvent);
        if (capturedHub.subscribers.size === 0) {
          capturedHub.watchHandle?.stop();
          this.hubs.delete(key);
        }
      },
    };
  }
}
