import { RESOURCE_DESCRIPTORS_BY_KIND } from '@a5e/schemas';
import type { AnsibleHostSpec, AnsibleInventorySpec, CustomResource } from '@a5e/schemas';
import type { CallerIdentity, CustomResourceClient } from './customResourceClient';
import { type ResolvedVarsSecret, type SecretReader, resolveVarsBySecretRefs } from './host-vars';
import { labelSelectorToString } from './label-selector';
import { resolveRefNamespace } from './ref-namespace';

export interface JumpChainHop {
  address: string;
  user?: string;
  port?: number;
}

export interface ResolvedHost {
  kind: 'AnsibleHost' | 'ClusterAnsibleHost';
  name: string;
  namespace?: string;
  spec: AnsibleHostSpec;
  /** Populated by `resolveJumpChain` — ordered outermost-hop-first, ready for `-J h1,h2,...`. */
  jumpChain?: JumpChainHop[];
  /** Populated by run-controller.ts after copying this host's `spec.sshKeyRef` target's Secret into a run-owned one — the mount name under `/ssh-keys/<name>/ssh-privatekey` in the Job (plan: SSH keys are a host property, not a run property, since different hosts commonly need different keys). */
  sshKeyMountName?: string;
  /**
   * Populated by `resolveInventoryGroups` only when it was given a `secretReader` — one entry per
   * `spec.varsBySecretRef` reference, in spec order. The vars they contribute sit underneath
   * `spec.vars` (an explicit inline var of the same name wins).
   */
  varsSecrets?: ResolvedVarsSecret[];
}

function refKey(kind: string, namespace: string | undefined, name: string): string {
  return `${kind}/${namespace ?? ''}/${name}`;
}

/**
 * Flattens a host's `jumpHost` (address or hostRef, possibly chained through other hosts'
 * jumpHosts) into an ordered list of hops for OpenSSH's `-J h1,h2,...` syntax — h1 is reached
 * first, the final hop in the list has direct network access to the target host itself. Chain
 * flattening happens here, once, at run-render time (plan §2.3/§3.4), not at Host-admission
 * time — a cycle (A -> B -> A) is only caught here, surfacing as a failed Run, not a rejected
 * AnsibleHost edit (documented limitation, see plan risk 14).
 */
export async function resolveJumpChain(
  client: CustomResourceClient,
  identity: CallerIdentity,
  host: Pick<ResolvedHost, 'kind' | 'name' | 'namespace' | 'spec'>,
  visited: Set<string> = new Set(),
): Promise<JumpChainHop[]> {
  const jumpHost = host.spec.jumpHost;
  if (!jumpHost) return [];

  const key = refKey(host.kind, host.namespace, host.name);
  if (visited.has(key)) {
    throw new Error(
      `JumpHostCycleDetected: cycle involving ${host.kind}/${host.namespace ?? ''}/${host.name}`,
    );
  }
  visited.add(key);

  if (jumpHost.address) {
    return [{ address: jumpHost.address, user: jumpHost.user, port: jumpHost.port }];
  }

  const ref = jumpHost.hostRef;
  if (!ref) return [];
  const descriptor = RESOURCE_DESCRIPTORS_BY_KIND[ref.kind]!;
  // `host.namespace` is already `undefined` for a ClusterAnsibleHost — resolveRefNamespace treats
  // that as "no namespace to restrict to", the one case a foreign ref.namespace is legitimate. A
  // namespaced host's jumpHost.hostRef pointing at another namespace was a real cross-tenant
  // vulnerability (see resolveRefNamespace's doc comment) before this check existed.
  const namespace = resolveRefNamespace(descriptor.scope, ref.namespace, host.namespace);
  const jumpObj = await client.get<CustomResource<AnsibleHostSpec, unknown>>(
    descriptor,
    ref.name,
    identity,
    namespace,
  );

  const jumpHostAsResolved = {
    kind: ref.kind,
    name: jumpObj.metadata.name,
    namespace: jumpObj.metadata.namespace,
    spec: jumpObj.spec,
  };
  const hopToReachJumpHost: JumpChainHop = {
    address: jumpObj.spec.ansibleAddress ?? jumpObj.spec.ansibleHost ?? jumpObj.metadata.name,
    user: jumpObj.spec.ansibleUser,
    port: jumpObj.spec.ansiblePort,
  };
  const upstream = await resolveJumpChain(client, identity, jumpHostAsResolved, visited);
  return [...upstream, hopToReachJumpHost];
}

export interface ResolvedGroup {
  name: string;
  hosts: ResolvedHost[];
  vars?: Record<string, unknown>;
  children?: string[];
}

export interface ResolveInventoryOptions {
  /** Set by the run controller (and the API's inventory-download route), which need real `-J`
   * chains for rendering; the inventory controller's status-only host-count reconcile leaves
   * this off to avoid the extra lookups. */
  resolveJumpChains?: boolean;
  /** Set by the same two callers to also dereference each host's `spec.varsBySecretRef` into
   * `ResolvedHost.varsSecrets`; left off wherever only host membership matters, so a host-count
   * reconcile never reads a Secret at all. */
  secretReader?: SecretReader;
}

/**
 * Resolves every group's `hostSources[]` against live AnsibleHost/ClusterAnsibleHost objects
 * (plan §2.6/§3.4). `inventoryNamespace` is the resolving inventory's own namespace (undefined
 * for a ClusterAnsibleInventory) — used only to default a namespaced host source's namespace
 * when omitted, per the namespace-semantics table; the CRD's own CEL validation already
 * guarantees `hostSources[].namespace` is present/absent exactly where required, so this
 * function does not need to re-validate that.
 *
 * Within one group, first-array-occurrence wins on selector overlap (documented, deterministic);
 * cross-group variable merging is left to Ansible's own precedence rules at `ansible-playbook`
 * runtime — this function's only job is correct host *membership* resolution.
 */
export async function resolveInventoryGroups(
  client: CustomResourceClient,
  identity: CallerIdentity,
  spec: AnsibleInventorySpec,
  inventoryNamespace: string | undefined,
  options: ResolveInventoryOptions = {},
): Promise<ResolvedGroup[]> {
  const groups: ResolvedGroup[] = [];
  for (const group of spec.groups) {
    const seen = new Set<string>();
    const hosts: ResolvedHost[] = [];
    for (const source of group.hostSources) {
      const descriptor = RESOURCE_DESCRIPTORS_BY_KIND[source.kind]!;
      const labelSelector = labelSelectorToString(source.labelSelector);
      const namespace =
        source.kind === 'AnsibleHost' ? (source.namespace ?? inventoryNamespace) : undefined;

      const result =
        descriptor.scope === 'Namespaced'
          ? await client.list<CustomResource<AnsibleHostSpec, unknown>>(
              descriptor,
              identity,
              namespace,
              {
                labelSelector,
              },
            )
          : await client.list<CustomResource<AnsibleHostSpec, unknown>>(
              descriptor,
              identity,
              undefined,
              {
                labelSelector,
              },
            );

      for (const hostObj of result.items) {
        if (hostObj.spec.enabled === false) continue;
        const key = `${source.kind}/${hostObj.metadata.namespace ?? ''}/${hostObj.metadata.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const resolved: ResolvedHost = {
          kind: source.kind,
          name: hostObj.metadata.name,
          namespace: hostObj.metadata.namespace,
          spec: hostObj.spec,
        };
        if (options.resolveJumpChains && hostObj.spec.jumpHost) {
          resolved.jumpChain = await resolveJumpChain(client, identity, resolved);
        }
        if (options.secretReader && hostObj.spec.varsBySecretRef?.length) {
          resolved.varsSecrets = await resolveVarsBySecretRefs(options.secretReader, resolved);
        }
        hosts.push(resolved);
      }
    }
    groups.push({ name: group.name, hosts, vars: group.vars, children: group.children });
  }
  return groups;
}
