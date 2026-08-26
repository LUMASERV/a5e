import { defineStore } from 'pinia';
import { ref } from 'vue';
import { apiClient } from '../api/client';

interface AppSettingsResponse {
  changeRequestsEnabled: boolean;
}

/**
 * App-wide feature toggles (currently just whether the change-request flow is offered at all —
 * see modules/app-settings.ts on the API side). Defaults to `true` until `load()` resolves, same
 * default the backend falls back to when unset, so nothing flickers hidden then visible for the
 * common case of the feature being on.
 */
export const useAppSettingsStore = defineStore('appSettings', () => {
  const changeRequestsEnabled = ref(true);
  const loaded = ref(false);
  let inFlight: Promise<void> | null = null;

  async function load() {
    const promise = apiClient.get<AppSettingsResponse>('/config/app-settings').then((result) => {
      changeRequestsEnabled.value = result.changeRequestsEnabled;
      loaded.value = true;
    });
    inFlight = promise.finally(() => {
      if (inFlight === promise) inFlight = null;
    });
    return inFlight;
  }

  /** For call sites that need the real value before deciding anything (e.g. `useStageOnDenied`'s
   * "offer to stage this?" upsell) rather than tolerating the `true`-until-loaded default —
   * DefaultLayout's unconditional `load()` on mount races with a 403 that can happen right away,
   * so a decision keyed on the flag should wait for whichever load is already in flight (or start
   * one) instead of reading a possibly-stale default. */
  async function ensureLoaded() {
    if (loaded.value) return;
    await (inFlight ?? load());
  }

  async function setChangeRequestsEnabled(value: boolean) {
    const result = await apiClient.replace<AppSettingsResponse>('/config/app-settings', {
      changeRequestsEnabled: value,
    });
    changeRequestsEnabled.value = result.changeRequestsEnabled;
  }

  return { changeRequestsEnabled, loaded, load, ensureLoaded, setChangeRequestsEnabled };
});
