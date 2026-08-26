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

  async function load() {
    const result = await apiClient.get<AppSettingsResponse>('/config/app-settings');
    changeRequestsEnabled.value = result.changeRequestsEnabled;
    loaded.value = true;
  }

  async function setChangeRequestsEnabled(value: boolean) {
    const result = await apiClient.replace<AppSettingsResponse>('/config/app-settings', {
      changeRequestsEnabled: value,
    });
    changeRequestsEnabled.value = result.changeRequestsEnabled;
  }

  return { changeRequestsEnabled, loaded, load, setChangeRequestsEnabled };
});
