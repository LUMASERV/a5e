import type { ResolvedGroup } from '@a5e/k8s-client';

/**
 * One shard of a `parallel`-enabled AnsibleRun: a subset of the resolved inventory's hosts that
 * gets its own Job/pod. Per code review (see PR #4): a shard does NOT get its own partial
 * inventory rendered — that broke plays that rely on the *whole* inventory still being visible
 * even while only running against some of it (`hostvars[<host outside this shard>]`,
 * `groups['x']` membership counts, `run_once`, `serial`, `delegate_to`, etc. all read the full
 * rendered inventory, not just the current play's targets). Every shard's pod mounts the SAME
 * full inventory ConfigMap (run-controller.ts's `prepareRunResources`) and is scoped to its hosts
 * purely via `ansible-playbook --limit` — exactly the mechanism Ansible itself provides for "run
 * this playbook against only some hosts of a larger inventory".
 */
export interface HostShard {
  /** 0-based, stable for the lifetime of the run (order is derived from `groups`, deterministic). */
  index: number;
  /** `AnsibleHost`/`ClusterAnsibleHost` names in this shard — for `status.shards[].hosts`
   * observability, and for re-deriving `limit` later (see `limitForHostNames`) if this shard is
   * only started after a later reconcile re-resolves the inventory. */
  hostNames: string[];
  /** The `--limit` value scoping a shard's pod to just these hosts: the *inventory* hostnames
   * (`ansibleHost ?? name` — can differ from `hostNames` above) joined with `:`, matching how
   * `renderInventoryIni` actually keys each host in the rendered inventory.ini. Ansible pattern
   * syntax, so `:` here means "union of these hosts", combinable with a user-supplied
   * `ansibleOptions.limit` via `:&` (intersection) — see run-controller.ts's `startShardJob`. */
  limit: string;
}

function inventoryHostname(host: { name: string; spec: { ansibleHost?: string } }): string {
  return host.spec.ansibleHost ?? host.name;
}

/**
 * Splits a resolved inventory's hosts into shards of at most `maxAmountOfHosts` each. Flattens
 * group-by-group, host-by-host (`resolveInventoryGroups`'s own order — deterministic given the
 * same AnsibleInventory spec); a host that appears in more than one group (legal — group
 * membership isn't exclusive) is counted once, by its first occurrence, so it ends up in exactly
 * one shard rather than being double-counted across two.
 */
export function shardHosts(groups: ResolvedGroup[], maxAmountOfHosts: number): HostShard[] {
  const seen = new Set<string>();
  const hosts: { name: string; inventoryHostname: string }[] = [];
  for (const group of groups) {
    for (const host of group.hosts) {
      const key = `${host.kind}/${host.namespace ?? ''}/${host.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hosts.push({ name: host.name, inventoryHostname: inventoryHostname(host) });
    }
  }

  const shards: HostShard[] = [];
  for (let start = 0; start < hosts.length; start += maxAmountOfHosts) {
    const chunk = hosts.slice(start, start + maxAmountOfHosts);
    shards.push({
      index: shards.length,
      hostNames: chunk.map((h) => h.name),
      limit: chunk.map((h) => h.inventoryHostname).join(':'),
    });
  }
  return shards;
}

/**
 * Re-derives a shard's `--limit` value from a freshly re-resolved `groups` and a previously
 * captured `hostNames` list — used when `pollParallelRun` starts a `Pending` shard only after a
 * later `prepareRunResources` call, whose `ResolvedHost` objects share no identity with the ones
 * `shardHosts` originally chunked. A named host that no longer resolves (deleted from the
 * inventory since the run started) is silently dropped rather than failing the run — the same
 * "best effort against a moving inventory" trade-off jump chain resolution already accepts
 * elsewhere.
 */
export function limitForHostNames(groups: ResolvedGroup[], hostNames: string[]): string {
  const nameSet = new Set(hostNames);
  const seen = new Set<string>();
  const limits: string[] = [];
  for (const group of groups) {
    for (const host of group.hosts) {
      if (!nameSet.has(host.name) || seen.has(host.name)) continue;
      seen.add(host.name);
      limits.push(inventoryHostname(host));
    }
  }
  return limits.join(':');
}
