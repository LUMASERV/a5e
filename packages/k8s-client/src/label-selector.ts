import type { LabelSelector } from '@a5e/schemas';

/** Converts a structured metav1.LabelSelector into the query-string form the k8s API expects. */
export function labelSelectorToString(selector: LabelSelector | undefined): string | undefined {
  if (!selector) return undefined;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(selector.matchLabels ?? {})) {
    parts.push(`${key}=${value}`);
  }
  for (const expr of selector.matchExpressions ?? []) {
    switch (expr.operator) {
      case 'In':
        parts.push(`${expr.key} in (${(expr.values ?? []).join(',')})`);
        break;
      case 'NotIn':
        parts.push(`${expr.key} notin (${(expr.values ?? []).join(',')})`);
        break;
      case 'Exists':
        parts.push(expr.key);
        break;
      case 'DoesNotExist':
        parts.push(`!${expr.key}`);
        break;
    }
  }
  return parts.length ? parts.join(',') : undefined;
}
