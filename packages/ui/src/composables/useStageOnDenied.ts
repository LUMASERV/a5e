import { ElMessageBox } from 'element-plus';
import { useRouter } from 'vue-router';
import { ApiError } from '../api/client';
import { useAppSettingsStore } from '../stores/appSettings';
import { useChangeRequestDraftStore } from '../stores/changeRequestDraft';
import type { MutationIntent } from '../stores/createResourceStore';

/**
 * The on-ramp from a one-off 403 into the same drafting/review flow `ChangeRequestDraftView.vue`
 * already provides — this only ever fires when NO draft is currently active (while drafting,
 * `createResourceStore`'s interceptor captures the mutation before it ever reaches the API, so a
 * 403 from a direct call can't happen in that state). On confirm, starts a fresh one-item draft
 * and jumps straight to the review page, reusing 100% of the same submit/cancel/diff UI instead
 * of a second parallel "propose this one thing" flow.
 */
export function useStageOnDenied() {
  const draftStore = useChangeRequestDraftStore();
  const appSettings = useAppSettingsStore();
  const router = useRouter();

  async function withStageOnDenied<T>(
    intent: MutationIntent,
    directCall: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await directCall();
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 403) throw err;
      // The flow is switched off for this install — surface the plain permission-denied error
      // instead of offering an upsell into a flow that would just 403 again on submit.
      if (!appSettings.changeRequestsEnabled) throw err;
      try {
        await ElMessageBox.confirm(
          "You don't have direct permission to do this. Submit as a change request for approval instead?",
          'Permission denied',
          { confirmButtonText: 'Submit as change request', type: 'warning' },
        );
      } catch {
        return undefined;
      }
      draftStore.start();
      draftStore.addItem(intent);
      router.push('/change-requests/draft');
      return undefined;
    }
  }

  return { withStageOnDenied };
}
