import {
  type JumpChainHop,
  type ResolvedGroup,
  type VarsSourceReader,
  resolveInventoryGroups,
  varsSourceValues,
} from '@a5e/k8s-client';
import { RESOURCE_DESCRIPTORS_BY_KIND, maskSecretValues } from '@a5e/schemas';
import type { AnsibleInventorySpec, AnsibleInventoryStatus, CustomResource } from '@a5e/schemas';
import YAML from 'yaml';
import { authorize } from '../auth/authorize';
import { canAct, resolveEffectivePermissions } from '../auth/permission-engine';
import { extractBearerToken } from '../auth/session';
import type { AnyElysia } from '../lib/elysia-types';
import { client, coreApi } from '../plugins/k8s';

function hopToSshTarget(hop: JumpChainHop): string {
  const userPrefix = hop.user ? `${hop.user}@` : '';
  const portSuffix = hop.port ? `:${hop.port}` : '';
  return `${userPrefix}${hop.address}${portSuffix}`;
}

/**
 * Reads a `varsFrom` source as the API's own identity, to list which host vars it contributes.
 * A Secret's values are masked before they reach the response body (see below); a ConfigMap's are
 * not, that being the point of offering both.
 */
const varsSourceReader: VarsSourceReader = {
  getSecret: (namespace, name) => coreApi.readNamespacedSecret({ name, namespace }),
  getConfigMap: (namespace, name) => coreApi.readNamespacedConfigMap({ name, namespace }),
};

/**
 * Renders already-resolved groups (host lookups + jump chain flattening done by
 * `resolveInventoryGroups` beforehand) as Ansible's YAML inventory format — for humans to
 * download and run `ansible-playbook -i` with directly, not what AnsibleRun Jobs actually use
 * (those get an INI rendering via renderInventoryIni, plus a per-host SSH key mount path that
 * only means anything inside a Job's Pod, deliberately omitted here).
 *
 * `varsFrom`-sourced host vars (hosts.ts) appear here by name. A Secret's values are masked above
 * `SECRET_VALUE_MASK_MIN_LENGTH` — the download is a human-readable view of what the inventory
 * resolves to, not a credential export, and `download` is a far weaker grant than `use` on the
 * Secret itself, so a downloaded file needs those vars supplied another way before it will
 * actually run. Values at or under that length are passed through verbatim; see secret-masking.ts
 * for why the threshold exists. A ConfigMap's values are shown as-is — a ConfigMap is not a
 * credential store, and masking it would make the download useless for the case it exists for.
 */
export function renderInventoryYaml(
  topLevelVars: Record<string, unknown> | undefined,
  groups: ResolvedGroup[],
): string {
  const childrenNode: Record<string, unknown> = {};

  for (const group of groups) {
    const hostsNode: Record<string, unknown> = {};
    for (const host of group.hosts) {
      const inventoryHostname = host.spec.ansibleHost ?? host.name;
      const hostVars: Record<string, unknown> = {
        ansible_host: host.spec.ansibleAddress ?? host.spec.ansibleHost ?? host.name,
      };
      if (host.spec.ansiblePort !== undefined) hostVars.ansible_port = host.spec.ansiblePort;
      if (host.spec.ansibleUser) hostVars.ansible_user = host.spec.ansibleUser;
      if (host.jumpChain?.length) {
        const proxyJump = host.jumpChain.map(hopToSshTarget).join(',');
        hostVars.ansible_ssh_common_args = `-o StrictHostKeyChecking=accept-new -J ${proxyJump}`;
      }
      for (const source of host.varsSources ?? []) {
        const values = varsSourceValues(source);
        Object.assign(hostVars, source.kind === 'Secret' ? maskSecretValues(values) : values);
      }
      Object.assign(hostVars, host.spec.vars ?? {});
      hostsNode[inventoryHostname] = hostVars;
    }

    const groupNode: Record<string, unknown> = {};
    if (Object.keys(hostsNode).length > 0) groupNode.hosts = hostsNode;
    if (group.vars && Object.keys(group.vars).length > 0) groupNode.vars = group.vars;
    if (group.children?.length)
      groupNode.children = Object.fromEntries(group.children.map((c) => [c, null]));
    childrenNode[group.name] = Object.keys(groupNode).length > 0 ? groupNode : null;
  }

  const all: Record<string, unknown> = { children: childrenNode };
  if (topLevelVars && Object.keys(topLevelVars).length > 0) all.vars = topLevelVars;
  return YAML.stringify({ all });
}

async function handleDownload(
  kind: 'AnsibleInventory' | 'ClusterAnsibleInventory',
  name: string,
  namespace: string | undefined,
  token?: string,
) {
  const auth = await authorize(token, 'user');
  if (auth instanceof Response) return auth;

  const descriptor = RESOURCE_DESCRIPTORS_BY_KIND[kind]!;
  const obj = await client.get<CustomResource<AnsibleInventorySpec, AnsibleInventoryStatus>>(
    descriptor,
    name,
    'self',
    namespace,
  );
  const perms = await resolveEffectivePermissions(auth.session, auth.role);
  if (!canAct(perms, { type: kind, namespace, labels: obj.metadata.labels }, 'download')) {
    return new Response(
      JSON.stringify({ error: 'forbidden', type: kind, namespace, action: 'download' }),
      {
        status: 403,
        headers: { 'content-type': 'application/json' },
      },
    );
  }
  // Internal reference traversal (Hosts via jump chains) is not individually re-checked per
  // referenced object — same trust model the operator already uses once you can see/download an
  // Inventory (see permission-engine.ts plan notes); only ChangeRequest items get per-item checks.
  const groups = await resolveInventoryGroups(client, 'self', obj.spec, namespace, {
    resolveJumpChains: true,
    varsSourceReader,
  });
  const yaml = renderInventoryYaml(obj.spec.vars, groups);

  return new Response(yaml, {
    headers: {
      'content-type': 'application/yaml',
      'content-disposition': `attachment; filename="${name}.yaml"`,
    },
  });
}

/** Registers the "download resolved inventory as YAML" route for both inventory kinds. */
export function registerInventoryDownloadRoutes(app: AnyElysia): AnyElysia {
  return app
    .get('/api/v1/namespaces/:namespace/ansibleinventories/:name/download', ({ params, headers }) =>
      handleDownload(
        'AnsibleInventory',
        params.name,
        params.namespace,
        extractBearerToken(headers),
      ),
    )
    .get('/api/v1/clusteransibleinventories/:name/download', ({ params, headers }) =>
      handleDownload(
        'ClusterAnsibleInventory',
        params.name,
        undefined,
        extractBearerToken(headers),
      ),
    );
}
