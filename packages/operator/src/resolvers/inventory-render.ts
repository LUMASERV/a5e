import type { JumpChainHop, ResolvedGroup } from '@a5e/k8s-client';

function formatIniValue(value: unknown): string {
  if (typeof value === 'string') return /\s/.test(value) ? JSON.stringify(value) : value;
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value);
}

function hopToSshTarget(hop: JumpChainHop): string {
  const userPrefix = hop.user ? `${hop.user}@` : '';
  const portSuffix = hop.port ? `:${hop.port}` : '';
  return `${userPrefix}${hop.address}${portSuffix}`;
}

/**
 * Pure INI-format renderer — no k8s calls. Takes already-resolved groups (host lookups and jump
 * chain flattening done by `resolveInventoryGroups`/`resolveJumpChain` beforehand) and produces
 * the exact text handed to `ansible-playbook -i`. INI over YAML for broadest `ansible-playbook`
 * compatibility (plan §3.4).
 */
export function renderInventoryIni(topLevelVars: Record<string, unknown> | undefined, groups: ResolvedGroup[]): string {
  const lines: string[] = [];

  for (const group of groups) {
    lines.push(`[${group.name}]`);
    for (const host of group.hosts) {
      const inventoryHostname = host.spec.ansibleHost ?? host.name;
      const address = host.spec.ansibleAddress ?? host.spec.ansibleHost ?? host.name;
      const parts = [`ansible_host=${formatIniValue(address)}`];
      if (host.spec.ansiblePort !== undefined) parts.push(`ansible_port=${host.spec.ansiblePort}`);
      if (host.spec.ansibleUser) parts.push(`ansible_user=${formatIniValue(host.spec.ansibleUser)}`);
      if (host.sshKeyMountName) {
        parts.push(`ansible_ssh_private_key_file=/ssh-keys/${host.sshKeyMountName}/ssh-privatekey`);
      }
      if (host.jumpChain?.length) {
        const proxyJump = host.jumpChain.map(hopToSshTarget).join(',');
        parts.push(`ansible_ssh_common_args=${JSON.stringify(`-o StrictHostKeyChecking=accept-new -J ${proxyJump}`)}`);
      }
      for (const [key, value] of Object.entries(host.spec.vars ?? {})) {
        parts.push(`${key}=${formatIniValue(value)}`);
      }
      lines.push(`${inventoryHostname} ${parts.join(' ')}`);
    }
    lines.push('');

    if (group.vars && Object.keys(group.vars).length > 0) {
      lines.push(`[${group.name}:vars]`);
      for (const [key, value] of Object.entries(group.vars)) lines.push(`${key}=${formatIniValue(value)}`);
      lines.push('');
    }

    if (group.children?.length) {
      lines.push(`[${group.name}:children]`);
      for (const child of group.children) lines.push(child);
      lines.push('');
    }
  }

  if (topLevelVars && Object.keys(topLevelVars).length > 0) {
    lines.push('[all:vars]');
    for (const [key, value] of Object.entries(topLevelVars)) lines.push(`${key}=${formatIniValue(value)}`);
    lines.push('');
  }

  return lines.join('\n');
}
