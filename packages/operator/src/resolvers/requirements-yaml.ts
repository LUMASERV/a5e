import type { AnsiblePlaybookSpec } from '@a5e/schemas';
import YAML from 'yaml';

/**
 * Renders `spec.dependencies` into a combined `requirements.yml` — `ansible-galaxy install -r`
 * and `ansible-galaxy collection install -r` both accept the same file, each reading only the
 * top-level key it understands (`roles:` / `collections:`).
 */
export function buildRequirementsYaml(
  dependencies: NonNullable<AnsiblePlaybookSpec['dependencies']>,
): string {
  return YAML.stringify({
    roles: dependencies.roles ?? [],
    collections: dependencies.collections ?? [],
  });
}
