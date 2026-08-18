import type * as k8s from '@kubernetes/client-node';
import {
  allNamespacesPath,
  type CustomResourceClient,
  resourcePath,
  watchReconnecting,
} from '@a5e/k8s-client';
import type { CustomResource, ResourceDescriptor } from '@a5e/schemas';

export interface ControllerOptions {
  /** Full re-list interval — self-heals from any watch events missed for any reason. Default 10 min. */
  resyncIntervalMs?: number;
  /** Debounce window before reconciling a changed object — collapses rapid-fire updates. Default 200ms. */
  debounceMs?: number;
  /** Cap on the exponential backoff applied after a reconcile error. Default 5 min. */
  maxBackoffMs?: number;
}

/**
 * `void`/`undefined` — reconciled fully, no further action needed until the next event/resync.
 * `{ requeueAfterMs }` — reconcile succeeded but the object isn't done yet (e.g. AnsibleRun
 * waiting on its Job) and should be revisited after a delay, WITHOUT that counting as an error
 * (no backoff growth, no error log) — the controller-runtime `Result{RequeueAfter}` pattern.
 */
export type ReconcileResult = void | { requeueAfterMs: number };
export type ReconcileFn<T> = (obj: T) => Promise<ReconcileResult>;

/** Scope-erased handle for holding a heterogeneous list of controllers (see main.ts). */
export interface Controller {
  start(): Promise<void>;
  stop(): void;
}

/**
 * Generic list+watch+workqueue harness for one CRD kind. `@kubernetes/client-node`'s informer
 * only gives raw add/update/delete callbacks, so this reimplements the client-go workqueue
 * pattern minimally: per-object-key debouncing, jittered exponential backoff on reconcile
 * errors, and a periodic full resync to self-heal from any missed watch events (plan §3.1/§3.3).
 *
 * One instance per Cluster-scoped/namespaced pair — pass the same `reconcile` function to both with
 * the two different descriptors, so the actual reconciliation logic is written once (plan's
 * ScopeAdapter idea: the descriptor + CustomResourceClient's scope-aware methods already play
 * that role, so no separate adapter interface is needed on top).
 */
export class ResourceController<TSpec, TStatus> implements Controller {
  private cache = new Map<string, CustomResource<TSpec, TStatus>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private retries = new Map<string, number>();
  private watchHandle: ReturnType<typeof watchReconnecting> | null = null;
  private stopped = false;

  constructor(
    private readonly kc: k8s.KubeConfig,
    private readonly client: CustomResourceClient,
    private readonly descriptor: ResourceDescriptor,
    private readonly reconcile: ReconcileFn<CustomResource<TSpec, TStatus>>,
    private readonly options: ControllerOptions = {},
  ) {}

  private keyOf(obj: CustomResource<TSpec, TStatus>): string {
    return obj.metadata.namespace ? `${obj.metadata.namespace}/${obj.metadata.name}` : obj.metadata.name;
  }

  async start(): Promise<void> {
    await this.resync();
    const resyncMs = this.options.resyncIntervalMs ?? 10 * 60_000;
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.resync();
      } catch (err) {
        console.error(`[${this.descriptor.kind}] periodic resync failed`, err);
      }
      if (!this.stopped) setTimeout(tick, resyncMs);
    };
    setTimeout(tick, resyncMs);
  }

  stop(): void {
    this.stopped = true;
    this.watchHandle?.stop();
    for (const timer of this.timers.values()) clearTimeout(timer);
  }

  private async resync(): Promise<void> {
    const isAllNamespaces = this.descriptor.scope === 'Namespaced';
    const result = isAllNamespaces
      ? await this.client.listAllNamespaces<CustomResource<TSpec, TStatus>>(this.descriptor, 'self')
      : await this.client.list<CustomResource<TSpec, TStatus>>(this.descriptor, 'self');

    const seenKeys = new Set<string>();
    for (const obj of result.items) {
      const key = this.keyOf(obj);
      seenKeys.add(key);
      this.cache.set(key, obj);
      this.schedule(key);
    }
    for (const key of this.cache.keys()) {
      if (!seenKeys.has(key)) this.cache.delete(key);
    }

    this.watchHandle?.stop();
    const path = isAllNamespaces ? allNamespacesPath(this.descriptor) : resourcePath(this.descriptor);
    this.watchHandle = watchReconnecting<CustomResource<TSpec, TStatus>>(
      this.kc,
      path,
      result.resourceVersion,
      'self',
      (event) => {
        const key = this.keyOf(event.object);
        if (event.type === 'DELETED') {
          this.cache.delete(key);
          this.clearSchedule(key);
        } else {
          this.cache.set(key, event.object);
          this.schedule(key);
        }
      },
      {
        onExpired: () => {
          this.resync().catch((err) => console.error(`[${this.descriptor.kind}] resync after 410 failed`, err));
        },
        onError: (err) => console.error(`[${this.descriptor.kind}] watch error`, err),
      },
    );
  }

  private clearSchedule(key: string) {
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
    this.retries.delete(key);
  }

  private schedule(key: string, delayOverrideMs?: number) {
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    const delay = delayOverrideMs ?? this.options.debounceMs ?? 200;
    this.timers.set(
      key,
      setTimeout(() => {
        this.run(key);
      }, delay),
    );
  }

  private async run(key: string): Promise<void> {
    this.timers.delete(key);
    const obj = this.cache.get(key);
    if (!obj) return;
    try {
      const result = await this.reconcile(obj);
      this.retries.delete(key);
      if (result?.requeueAfterMs !== undefined) {
        this.schedule(key, result.requeueAfterMs);
      }
    } catch (err) {
      console.error(`[${this.descriptor.kind}] reconcile failed for ${key}`, err);
      const attempt = (this.retries.get(key) ?? 0) + 1;
      this.retries.set(key, attempt);
      const cap = this.options.maxBackoffMs ?? 5 * 60_000;
      const backoff = Math.min(cap, 1000 * 2 ** attempt) * (0.5 + Math.random() * 0.5);
      this.schedule(key, backoff);
    }
  }
}
