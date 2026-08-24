import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { apiClient, apiUrl } from '../api/client';
import { setToken } from '../api/token';

export type AppRole = 'none' | 'user' | 'admin';

interface WhoAmI {
  displayName: string;
  identity: { impersonateUser: string; impersonateGroups?: string[] };
  role: AppRole;
}

export const useAuthStore = defineStore('auth', () => {
  const session = ref<WhoAmI | null>(null);
  const checked = ref(false);

  async function check() {
    try {
      session.value = await apiClient.get<WhoAmI>('/whoami');
    } catch {
      session.value = null;
    } finally {
      checked.value = true;
    }
  }

  function login() {
    // A full-page navigation, not a fetch — must go to the API's actual own origin (apiUrl()
    // already resolves that, same as every other apiClient call), since this is the browser
    // itself starting the OIDC redirect dance, not something a cross-origin fetch could do.
    window.location.href = apiUrl('/auth/login');
  }

  async function localLogin(username: string, password: string) {
    const { token } = await apiClient.post<{ token: string }>('/auth/local-login', {
      username,
      password,
    });
    setToken(token);
    await check();
  }

  async function logout() {
    try {
      await apiClient.post('/auth/logout');
    } finally {
      setToken(null);
      session.value = null;
      window.location.href = '/login';
    }
  }

  const role = computed<AppRole>(() => session.value?.role ?? 'none');
  const isAdmin = computed(() => role.value === 'admin');
  const hasAccess = computed(() => role.value !== 'none');

  return { session, checked, role, isAdmin, hasAccess, check, login, localLogin, logout };
});
