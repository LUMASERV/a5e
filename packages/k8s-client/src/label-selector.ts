import type { LabelSelector } from '@a5e/schemas';

/** Evaluates a structured metav1.LabelSelector against an already-fetched object's labels, purely
 * in-memory (no k8s round trip) — used by the permission engine's `canAct`/watch-filter checks,
 * where the object is already in hand and a query-string round trip would be pointless. An absent
 * selector matches everything (the "no label restriction" case). */
export function labelSelectorMatches(
  selector: LabelSelector | undefined,
  labels: Record<string, string> | undefined,
): boolean {
  if (!selector) return true;
  const l = labels ?? {};
  for (const [key, value] of Object.entries(selector.matchLabels ?? {})) {
    if (l[key] !== value) return false;
  }
  for (const expr of selector.matchExpressions ?? []) {
    const value = l[expr.key];
    switch (expr.operator) {
      case 'In':
        if (value === undefined || !(expr.values ?? []).includes(value)) return false;
        break;
      case 'NotIn':
        if (value !== undefined && (expr.values ?? []).includes(value)) return false;
        break;
      case 'Exists':
        if (value === undefined) return false;
        break;
      case 'DoesNotExist':
        if (value !== undefined) return false;
        break;
    }
  }
  return true;
}

/**
 * Inverse of `labelSelectorToString`, only needing to round-trip the syntax subset that function
 * itself produces (`key=value`, `key in (...)`, `key notin (...)`, bare `key`, `!key`) — the only
 * source of these strings is this same codebase's own UI (LabelSelectorEditor.vue ->
 * labelSelectorToString), not arbitrary kubectl-style input, so this deliberately doesn't attempt
 * to support the full k8s selector grammar (whitespace variants, `==`, set-based without spaces).
 */
export function parseLabelSelectorString(selector: string | undefined): LabelSelector | undefined {
  const trimmed = selector?.trim();
  if (!trimmed) return undefined;
  const matchLabels: Record<string, string> = {};
  const matchExpressions: NonNullable<LabelSelector['matchExpressions']> = [];
  for (const rawPart of trimmed.split(',')) {
    const part = rawPart.trim();
    if (!part) continue;
    const inMatch = part.match(/^([^\s]+)\s+in\s+\(([^)]*)\)$/);
    const notInMatch = part.match(/^([^\s]+)\s+notin\s+\(([^)]*)\)$/);
    if (inMatch) {
      matchExpressions.push({
        key: inMatch[1]!,
        operator: 'In',
        values: inMatch[2]!
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
      });
    } else if (notInMatch) {
      matchExpressions.push({
        key: notInMatch[1]!,
        operator: 'NotIn',
        values: notInMatch[2]!
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
      });
    } else if (part.startsWith('!')) {
      matchExpressions.push({ key: part.slice(1), operator: 'DoesNotExist' });
    } else if (part.includes('=')) {
      const eqIndex = part.indexOf('=');
      matchLabels[part.slice(0, eqIndex)] = part.slice(eqIndex + 1);
    } else {
      matchExpressions.push({ key: part, operator: 'Exists' });
    }
  }
  const result: LabelSelector = {};
  if (Object.keys(matchLabels).length) result.matchLabels = matchLabels;
  if (matchExpressions.length) result.matchExpressions = matchExpressions;
  return Object.keys(result).length ? result : undefined;
}

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
