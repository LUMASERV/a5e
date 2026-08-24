import { type JumpChainHop, type ResolvedGroup, resolveInventoryGroups } from '@a5e/k8s-client';
import { RESOURCE_DESCRIPTORS_BY_KIND } from '@a5e/schemas';
import type { AnsibleInventorySpec, AnsibleInventoryStatus, CustomResource } from '@a5e/schemas';
import YAML from 'yaml';
import { authorize } from '../auth/authorize';
import { extractBearerToken } from '../auth/session';
import type { AnyElysia } from '../lib/elysia-types';
import { client } from '../plugins/k8s';

function hopToSshTarget(hop: JumpChainHop): string {
  const userPrefix = hop.user ? `${hop.user}@` : '';
  const portSuffix = hop.port ? `:${hop.port}` : '';
  return `${userPrefix}${hop.address}${portSuffix}`;
}

/**
 * Renders already-resolved groups (host lookups + jump chain flattening done by
 * `resolveInventoryGroups` beforehand) as Ansible's YAML inventory format — for humans to
 * download and run `ansible-playbook -i` with directly, not what AnsibleRun Jobs actually use
 * (those get an INI rendering via renderInventoryIni, plus a per-host SSH key mount path that
 * only means anything inside a Job's Pod, deliberately omitted here).
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
  const { session } = auth;

  const descriptor = RESOURCE_DESCRIPTORS_BY_KIND[kind]!;
  const obj = await client.get<CustomResource<AnsibleInventorySpec, AnsibleInventoryStatus>>(
    descriptor,
    name,
    session.identity,
    namespace,
  );
  const groups = await resolveInventoryGroups(client, session.identity, obj.spec, namespace, true);
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
