import type { CustomResource, ResourceDescriptor } from '@a5e/schemas';
import { defineStore } from 'pinia';
import { ref, shallowRef } from 'vue';
import { apiClient } from '../api/client';
import { resourceBasePath } from '../api/resource-path';
import { watchResource } from '../api/watch';

function keyOf(obj: CustomResource<unknown, unknown>): string {
  return obj.metadata.namespace
    ? `${obj.metadata.namespace}/${obj.metadata.name}`
    : obj.metadata.name;
}

/**
 * One store per kind via this factory (plan §5.2) — avoids 9x hand-duplicated CRUD/watch
 * boilerplate. `list()` opens/reuses the SSE watch relay and reconciles ADDED/MODIFIED/DELETED
 * into a reactive map keyed by `namespace/name` (or `name` for cluster-scoped).
 */
export function createResourceStore<TSpec, TStatus>(id: string, descriptor: ResourceDescriptor) {
  return defineStore(id, () => {
    // shallowRef, not ref: the Map holds generically-typed (TSpec/TStatus) values Vue's deep
    // reactivity can't structurally prove UnwrapRef-safe, and we don't need nested reactivity —
    // every mutation below replaces the Map wholesale, which shallowRef already reacts to.
    const items = shallowRef(new Map<string, CustomResource<TSpec, TStatus>>());
    const loading = ref(false);
    const error = ref<string | null>(null);
    let stopWatch: (() => void) | null = null;

    async function list(namespace?: string, labelSelector?: string) {
      loading.value = true;
      error.value = null;
      try {
        const path = resourceBasePath(descriptor, namespace);
        const result = await apiClient.list<CustomResource<TSpec, TStatus>>(path, {
          labelSelector,
        });
        items.value = new Map(result.items.map((o) => [keyOf(o), o]));

        stopWatch?.();
        const watchPath = `${path}/watch${labelSelector ? `?labelSelector=${encodeURIComponent(labelSelector)}` : ''}`;
        stopWatch = watchResource(watchPath, (type, object) => {
          const obj = object as CustomResource<TSpec, TStatus>;
          const next = new Map(items.value);
          if (type === 'DELETED') next.delete(keyOf(obj));
          else next.set(keyOf(obj), obj);
          items.value = next;
        });
      } catch (err) {
        error.value = (err as Error).message;
      } finally {
        loading.value = false;
      }
    }

    function get(name: string, namespace?: string) {
      return apiClient.get<CustomResource<TSpec, TStatus>>(
        `${resourceBasePath(descriptor, namespace)}/${name}`,
      );
    }
    function create(body: unknown, namespace?: string) {
      return apiClient.create<CustomResource<TSpec, TStatus>>(
        resourceBasePath(descriptor, namespace),
        body,
      );
    }
    function update(name: string, body: unknown, namespace?: string) {
      return apiClient.replace<CustomResource<TSpec, TStatus>>(
        `${resourceBasePath(descriptor, namespace)}/${name}`,
        body,
      );
    }
    function patch(name: string, body: unknown, namespace?: string) {
      return apiClient.patch<CustomResource<TSpec, TStatus>>(
        `${resourceBasePath(descriptor, namespace)}/${name}`,
        body,
      );
    }
    function remove(name: string, namespace?: string) {
      return apiClient.remove(`${resourceBasePath(descriptor, namespace)}/${name}`);
    }
    function stop() {
      stopWatch?.();
      stopWatch = null;
    }

    return { items, loading, error, list, get, create, update, patch, remove, stop };
  });
}
