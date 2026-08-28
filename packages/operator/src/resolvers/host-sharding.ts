import type { ResolvedGroup, ResolvedHost } from '@a5e/k8s-client';

/** A run's inventory split into one shard per Job/pod a `parallel`-enabled AnsibleRun spawns. */
export interface HostShard {
  /** 0-based, stable for the lifetime of the run (order is derived from `groups`, deterministic). */
  index: number;
  /** This shard's slice of the inventory, re-grouped exactly like `groups` (same names/vars/
   * children) but containing only the hosts assigned to it — a group with none of its hosts in
   * this shard is dropped entirely so the rendered inventory.ini doesn't declare empty groups. */
  groups: ResolvedGroup[];
  /** `AnsibleHost`/`ClusterAnsibleHost` names in this shard, in the order they'll appear in the
   * rendered inventory — for `status.shards[].hosts` observability only. */
  hostNames: string[];
}

/**
 * Splits a resolved inventory into shards of at most `maxAmountOfHosts` hosts each, preserving
 * each host's original group membership (and therefore its group vars) — a shard's inventory.ini
 * is a strict subset of the full inventory's, never a re-flattened "all hosts, one group" one.
 *
 * Flattens group-by-group, host-by-host (`resolveInventoryGroups`'s own order — deterministic
 * given the same AnsibleInventory spec) into chunks of `maxAmountOfHosts`; a host that appears in
 * more than one group (legal — group membership isn't exclusive) is chunked by its *first*
 * occurrence only and carries every group it belongs to along with it, so it still ends up in
 * exactly one shard rather than being split across two pods.
 */
export function shardHosts(groups: ResolvedGroup[], maxAmountOfHosts: number): HostShard[] {
  const groupsByHost = new Map<ResolvedHost, ResolvedGroup[]>();
  const order: ResolvedHost[] = [];
  for (const group of groups) {
    for (const host of group.hosts) {
      let hostGroups = groupsByHost.get(host);
      if (!hostGroups) {
        hostGroups = [];
        groupsByHost.set(host, hostGroups);
        order.push(host);
      }
      hostGroups.push(group);
    }
  }

  const shards: HostShard[] = [];
  for (let start = 0; start < order.length; start += maxAmountOfHosts) {
    const hosts = order.slice(start, start + maxAmountOfHosts);
    const hostSet = new Set(hosts);
    const shardGroups: ResolvedGroup[] = groups
      .filter((group) => group.hosts.some((h) => hostSet.has(h)))
      .map((group) => ({ ...group, hosts: group.hosts.filter((h) => hostSet.has(h)) }));
    shards.push({
      index: shards.length,
      groups: shardGroups,
      hostNames: hosts.map((h) => h.name),
    });
  }
  return shards;
}

/**
 * Rebuilds the same shard-shaped group slice `shardHosts` would have produced, but keyed by a
 * captured list of host *names* rather than object identity — needed because `groups` here comes
 * from a fresh `resolveInventoryGroups` call (run-controller.ts's `prepareRunResources`, re-run
 * to fill a `Pending` shard slot once concurrency frees up), whose `ResolvedHost` objects share no
 * identity with the ones `shardHosts` originally chunked. If a named host no longer resolves
 * (deleted from the inventory since the run started), it's silently dropped from the shard rather
 * than failing the run — the same "best effort against a moving inventory" trade-off jump chain
 * resolution already accepts elsewhere.
 */
export function groupsForHostNames(groups: ResolvedGroup[], hostNames: string[]): ResolvedGroup[] {
  const nameSet = new Set(hostNames);
  return groups
    .filter((group) => group.hosts.some((h) => nameSet.has(h.name)))
    .map((group) => ({ ...group, hosts: group.hosts.filter((h) => nameSet.has(h.name)) }));
}
