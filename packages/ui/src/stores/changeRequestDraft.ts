import type { Pinia } from 'pinia';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  type DraftItem,
  clearDraftEnvelope,
  loadDraftEnvelope,
  saveDraftEnvelope,
} from '../lib/changeRequestDraftStorage';
import { useAppSettingsStore } from './appSettings';
import { useAuthStore } from './auth';
import type { MutationIntent, MutationInterceptorResult } from './createResourceStore';
import { registerMutationInterceptor } from './createResourceStore';

/** Kinds a change-request draft can capture — an allow-list, not a deny-list, so a future new
 * kind is never silently swallowed into drafts by default. AnsibleRun is deliberately excluded:
 * triggering/creating a Run is an execute-now action, not a durable config change, and has no
 * create/update/delete slot that fits the ChangeItem model. */
export const STAGEABLE_KINDS = [
  'AnsibleHost',
  'ClusterAnsibleHost',
  'AnsibleInventory',
  'ClusterAnsibleInventory',
  'AnsiblePlaybook',
  'ClusterAnsiblePlaybook',
  'AnsibleSSHKey',
  'ClusterAnsibleSSHKey',
  'AnsibleJob',
] as const;

function synthesizeResult(intent: MutationIntent): unknown {
  if (intent.kind === 'delete') return undefined;
  const body = (intent.body ?? {}) as { metadata?: Record<string, unknown>; [k: string]: unknown };
  return {
    ...body,
    metadata: {
      name: intent.name ?? '(pending)',
      namespace: intent.namespace,
      ...body.metadata,
    },
  };
}

export const useChangeRequestDraftStore = defineStore('changeRequestDraft', () => {
  const started = ref(false);
  const reason = ref('');
  const items = ref<DraftItem[]>([]);

  // Gated on the app-wide toggle too, not just `started`: a draft rehydrated from localStorage
  // (see rehydrate() below) can have started=true from before an admin turned the flow off
  // mid-session — every consumer of `isActive` (the mutation interceptor, ResourceListView's
  // "added to draft" messaging, ObjectRefPicker's staged-item lookups) should treat that the same
  // as no draft being active, not keep quietly capturing into a request nothing can submit.
  const isActive = computed(() => started.value && useAppSettingsStore().changeRequestsEnabled);

  function currentUserId(): string | undefined {
    return useAuthStore().session?.identity.impersonateUser;
  }

  function persist() {
    const userId = currentUserId();
    if (!userId) return;
    saveDraftEnvelope(userId, { v: 1, reason: reason.value, items: items.value });
  }

  /** Restores a draft persisted under the current session's identity — called once from
   * DefaultLayout.vue's onMounted, after the session is known. A draft found unparseable or from
   * a different schema version is silently discarded rather than crashing app boot. */
  function rehydrate() {
    const userId = currentUserId();
    if (!userId) return;
    const envelope = loadDraftEnvelope(userId);
    if (!envelope) return;
    reason.value = envelope.reason;
    items.value = envelope.items;
    // Finding a persisted envelope at all means drafting was started, even before anything was
    // staged or a reason typed — otherwise a reload right after clicking "Start change request"
    // (before making any changes yet) would silently drop back to the idle state.
    started.value = true;
  }

  function start() {
    started.value = true;
    persist();
  }

  /** Clears the whole draft — both in-memory and the persisted copy — used for both an explicit
   * "Cancel change request" and a successful submit. */
  function cancel() {
    started.value = false;
    reason.value = '';
    items.value = [];
    const userId = currentUserId();
    if (userId) clearDraftEnvelope(userId);
  }

  function addItem(intent: MutationIntent) {
    started.value = true;
    items.value = [
      ...items.value,
      { ...intent, id: crypto.randomUUID(), stagedAt: new Date().toISOString() },
    ];
    persist();
  }

  function removeItem(id: string) {
    items.value = items.value.filter((i) => i.id !== id);
    persist();
  }

  function setReason(value: string) {
    reason.value = value;
    persist();
  }

  return {
    started,
    reason,
    items,
    isActive,
    start,
    cancel,
    addItem,
    removeItem,
    setReason,
    rehydrate,
  };
});

/**
 * Wires the draft store into `createResourceStore`'s global mutation hook — called once from
 * main.ts. This is the ONLY place that couples the otherwise-generic store factory to change
 * requests: every create/update/patch/remove call across every stageable kind is captured here
 * without any individual view needing to opt in.
 */
export function registerChangeRequestInterceptor(pinia: Pinia): void {
  const draftStore = useChangeRequestDraftStore(pinia);
  registerMutationInterceptor((intent): MutationInterceptorResult => {
    if (intent.type === 'ChangeRequest') return { staged: false };
    if (!(STAGEABLE_KINDS as readonly string[]).includes(intent.type)) return { staged: false };
    // isActive itself accounts for the app-wide toggle (see its definition above) — a draft
    // started before an admin turned the flow off mid-session stops capturing immediately.
    if (!draftStore.isActive) return { staged: false };
    draftStore.addItem(intent);
    return { staged: true, result: synthesizeResult(intent) };
  });
}
