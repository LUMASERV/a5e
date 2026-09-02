import type { JumpChainHop, ResolvedGroup, ResolvedVarsSecret } from '@a5e/k8s-client';

function formatIniValue(value: unknown): string {
  if (typeof value === 'string') return /\s/.test(value) ? JSON.stringify(value) : value;
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value);
}

/**
 * Renders one Secret-sourced host var as a Jinja `file` lookup against the run-owned Secret copy
 * the Job mounts (job-builder.ts), rather than embedding the value itself. Three reasons this is
 * the value, not just a hiding place:
 *
 *  - The inventory stays an ordinary ConfigMap, safe to read, diff and `kubectl get -o yaml` for
 *    debugging, while the values live only in a Secret that is a byte-for-byte copy of the source.
 *  - Ansible templates inventory var values, so a *literal* value containing `{{ ... }}` would
 *    blow the play up with an "undefined" error (verified against ansible-core 2.20). A lookup's
 *    *result* is not re-templated, so any byte sequence round-trips intact.
 *  - `rstrip=False` keeps the file lookup from silently trimming trailing whitespace/newlines,
 *    which it does by default — Kubernetes projects a Secret key's exact bytes into the file, and
 *    a credential ending in a newline must stay that way.
 *
 * Double-quoted because the expression contains spaces: Ansible's INI parser shlex-splits the
 * host line (so the quotes make it one token, inner single quotes preserved) and then declines to
 * `literal_eval` it, leaving the template string intact for task-time evaluation.
 */
function secretVarLookup(secret: ResolvedVarsSecret, key: string): string {
  const path = `/host-vars/${secret.mountName}/${key}`;
  return `"{{ lookup('file', '${path}', rstrip=False) }}"`;
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
export function renderInventoryIni(
  topLevelVars: Record<string, unknown> | undefined,
  groups: ResolvedGroup[],
): string {
  const lines: string[] = [];

  for (const group of groups) {
    lines.push(`[${group.name}]`);
    for (const host of group.hosts) {
      const inventoryHostname = host.spec.ansibleHost ?? host.name;
      const address = host.spec.ansibleAddress ?? host.spec.ansibleHost ?? host.name;
      const parts = [`ansible_host=${formatIniValue(address)}`];
      if (host.spec.ansiblePort !== undefined) parts.push(`ansible_port=${host.spec.ansiblePort}`);
      if (host.spec.ansibleUser)
        parts.push(`ansible_user=${formatIniValue(host.spec.ansibleUser)}`);
      if (host.sshKeyMountName) {
        parts.push(`ansible_ssh_private_key_file=/ssh-keys/${host.sshKeyMountName}/ssh-privatekey`);
      }
      if (host.jumpChain?.length) {
        const proxyJump = host.jumpChain.map(hopToSshTarget).join(',');
        parts.push(
          `ansible_ssh_common_args=${JSON.stringify(`-o StrictHostKeyChecking=accept-new -J ${proxyJump}`)}`,
        );
      }
      // Secret-sourced vars first (in spec order, so a later `varsBySecret` entry overrides an
      // earlier one), then inline `spec.vars` last — an explicit inline var always beats a
      // Secret-sourced one of the same name (hosts.ts). `Object.entries` on the merged record
      // keeps first-insertion order, so an overridden key stays where it first appeared while
      // taking the winning value.
      const hostVars: Record<string, string> = {};
      for (const secret of host.varsSecrets ?? []) {
        for (const key of Object.keys(secret.data)) {
          hostVars[key] = secretVarLookup(secret, key);
        }
      }
      for (const [key, value] of Object.entries(host.spec.vars ?? {})) {
        hostVars[key] = formatIniValue(value);
      }
      for (const [key, value] of Object.entries(hostVars)) {
        parts.push(`${key}=${value}`);
      }
      lines.push(`${inventoryHostname} ${parts.join(' ')}`);
    }
    lines.push('');

    if (group.vars && Object.keys(group.vars).length > 0) {
      lines.push(`[${group.name}:vars]`);
      for (const [key, value] of Object.entries(group.vars))
        lines.push(`${key}=${formatIniValue(value)}`);
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
    for (const [key, value] of Object.entries(topLevelVars))
      lines.push(`${key}=${formatIniValue(value)}`);
    lines.push('');
  }

  return lines.join('\n');
}
