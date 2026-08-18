import type { CustomResourceClient } from '@a5e/k8s-client';
import type { CustomResource, ResourceDescriptor } from '@a5e/schemas';
import type { Controller } from './informer';

/**
 * Drives AnsibleJob's schedule checks on a fixed interval instead of the event-driven
 * add/update/delete workqueue every other controller uses (see ResourceController) — a cron
 * schedule needs to be re-evaluated as time passes, not just when the AnsibleJob object itself
 * changes. Deliberately much simpler than ResourceController: no watch, no per-object debounce —
 * just "list everything, reconcile each one, log and move on if one fails" every tick.
 */
export class CronTicker implements Controller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private readonly client: CustomResourceClient,
    private readonly descriptor: ResourceDescriptor,
    private readonly reconcile: (obj: CustomResource<unknown, unknown>) => Promise<void>,
    private readonly intervalMs = 15_000,
  ) {}

  async start(): Promise<void> {
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return; // previous tick still running (e.g. many jobs, slow API) — skip, don't pile up
    this.ticking = true;
    try {
      const { items } = await this.client.listAllNamespaces<CustomResource<unknown, unknown>>(this.descriptor, 'self');
      for (const obj of items) {
        try {
          await this.reconcile(obj);
        } catch (err) {
          console.error(`cron-ticker: reconcile failed for ${obj.metadata.namespace}/${obj.metadata.name}:`, err);
        }
      }
    } catch (err) {
      console.error('cron-ticker: list failed:', err);
    } finally {
      this.ticking = false;
    }
  }
}
