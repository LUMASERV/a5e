import type { MutationIntent } from '../stores/createResourceStore';

export interface DraftItem extends MutationIntent {
  id: string;
  stagedAt: string;
}

interface DraftEnvelope {
  v: 1;
  reason: string;
  items: DraftItem[];
}

function storageKey(userId: string): string {
  return `a5e:changerequest-draft:${userId}`;
}

/** Defensively returns `null` on anything unparseable/unexpected — a stored draft is convenience,
 * never something worth crashing app boot over. */
export function loadDraftEnvelope(userId: string): DraftEnvelope | null {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.v !== 1 || !Array.isArray(parsed.items)) return null;
    return parsed as DraftEnvelope;
  } catch {
    return null;
  }
}

export function saveDraftEnvelope(userId: string, envelope: DraftEnvelope): void {
  localStorage.setItem(storageKey(userId), JSON.stringify(envelope));
}

export function clearDraftEnvelope(userId: string): void {
  localStorage.removeItem(storageKey(userId));
}
