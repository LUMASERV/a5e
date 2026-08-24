<script setup lang="ts">
import { Loading } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { setToken } from '../api/token';
import { useAuthStore } from '../stores/auth';

const router = useRouter();
const auth = useAuthStore();

onMounted(async () => {
  // The token lives in the URL *fragment* (never sent to any server — see auth/routes.ts's OIDC
  // callback for why), so only this page's own JS can read it, via location.hash rather than a
  // route query param.
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const token = params.get('token');
  if (!token) {
    router.replace({ name: 'login', query: { error: 'Login failed: no token received.' } });
    return;
  }

  setToken(token);
  await auth.check();
  if (!auth.session) {
    ElMessage.error('Login failed: could not establish a session with that token.');
    router.replace({ name: 'login' });
    return;
  }
  router.replace({ name: 'dashboard' });
});
</script>

<template>
  <div style="display: flex; align-items: center; justify-content: center; height: 100vh">
    <el-icon class="is-loading" :size="32"><Loading /></el-icon>
  </div>
</template>
