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
 * Describes a create/update/delete a caller is about to perform, before it's actually sent to the
 * API — the hook a change-request draft (stores/changeRequestDraft.ts) intercepts to capture the
 * mutation instead of applying it. Kept generic here (no import of anything change-request-
 * specific) so this factory stays usable on its own; `registerMutationInterceptor` is the only
 * coupling point, and it's a no-op (`null`) until something registers one.
 */
export interface MutationIntent {
  kind: 'create' | 'update' | 'delete';
  type: string;
  namespace?: string;
  name?: string;
  body?: unknown;
  /** The object as fetched before this mutation — only ever set for update/delete, and only used
   * for building a real before/after diff in the draft review UI, never sent to the server. */
  previous?: unknown;
}
export type MutationInterceptorResult = { staged: true; result: unknown } | { staged: false };
type MutationInterceptor = (intent: MutationIntent) => MutationInterceptorResult;

let mutationInterceptor: MutationInterceptor | null = null;

/** Registers the one global interceptor every resource store's create/update/patch/remove checks
 * first — called once from main.ts. Pass `null` to clear it. */
export function registerMutationInterceptor(fn: MutationInterceptor | null): void {
  mutationInterceptor = fn;
}

/**
 * One store per kind via this factory — avoids 9x hand-duplicated CRUD/watch boilerplate.
 * `list()` opens/reuses the SSE watch relay and reconciles ADDED/MODIFIED/DELETED into a
 * reactive map keyed by `namespace/name` (or `name` for cluster-scoped).
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
      // `name` isn't a separate create() argument (it's embedded in body.metadata.name) — surface
      // it on the intent anyway so drafting/review UI can display it without reaching into body.
      const name = (body as { metadata?: { name?: string } } | undefined)?.metadata?.name;
      const staged = mutationInterceptor?.({
        kind: 'create',
        type: descriptor.kind,
        namespace,
        name,
        body,
      });
      if (staged?.staged) return Promise.resolve(staged.result as CustomResource<TSpec, TStatus>);
      return apiClient.create<CustomResource<TSpec, TStatus>>(
        resourceBasePath(descriptor, namespace),
        body,
      );
    }
    function update(name: string, body: unknown, namespace?: string, previous?: unknown) {
      const staged = mutationInterceptor?.({
        kind: 'update',
        type: descriptor.kind,
        namespace,
        name,
        body,
        previous,
      });
      if (staged?.staged) return Promise.resolve(staged.result as CustomResource<TSpec, TStatus>);
      return apiClient.replace<CustomResource<TSpec, TStatus>>(
        `${resourceBasePath(descriptor, namespace)}/${name}`,
        body,
      );
    }
    function patch(name: string, body: unknown, namespace?: string, previous?: unknown) {
      const staged = mutationInterceptor?.({
        kind: 'update',
        type: descriptor.kind,
        namespace,
        name,
        body,
        previous,
      });
      if (staged?.staged) return Promise.resolve(staged.result as CustomResource<TSpec, TStatus>);
      return apiClient.patch<CustomResource<TSpec, TStatus>>(
        `${resourceBasePath(descriptor, namespace)}/${name}`,
        body,
      );
    }
    function remove(name: string, namespace?: string, previous?: unknown) {
      const staged = mutationInterceptor?.({
        kind: 'delete',
        type: descriptor.kind,
        namespace,
        name,
        previous,
      });
      if (staged?.staged) return Promise.resolve();
      return apiClient.remove(`${resourceBasePath(descriptor, namespace)}/${name}`);
    }
    function stop() {
      stopWatch?.();
      stopWatch = null;
    }

    return { items, loading, error, list, get, create, update, patch, remove, stop };
  });
}
