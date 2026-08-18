<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useAuthStore } from '../stores/auth';
import { apiClient } from '../api/client';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const form = reactive({ username: '', password: '' });
const loading = ref(false);
const oidcConfigured = ref(false);

async function submitLocalLogin() {
  loading.value = true;
  try {
    await auth.localLogin(form.username, form.password);
    router.push('/');
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  const error = route.query.error;
  if (typeof error === 'string') {
    ElMessage.error(error);
    router.replace({ query: { ...route.query, error: undefined } });
  }
  try {
    oidcConfigured.value = (await apiClient.get<{ configured: boolean }>('/auth/oidc-status')).configured;
  } catch {
    oidcConfigured.value = false;
  }
});
</script>

<template>
  <div style="display: flex; align-items: center; justify-content: center; height: 100vh">
    <el-card style="width: 360px; text-align: center">
      <h2>A5E</h2>
      <template v-if="oidcConfigured">
        <el-button type="primary" style="margin-top: 16px; width: 100%" @click="auth.login">Sign in with SSO</el-button>
        <el-divider>or</el-divider>
      </template>

      <el-form style="text-align: left" @submit.prevent="submitLocalLogin">
        <el-form-item label="Username">
          <el-input v-model="form.username" autocomplete="username" />
        </el-form-item>
        <el-form-item label="Password">
          <el-input v-model="form.password" type="password" show-password autocomplete="current-password" @keyup.enter="submitLocalLogin" />
        </el-form-item>
        <el-button :loading="loading" style="width: 100%" @click="submitLocalLogin">Sign in with local account</el-button>
      </el-form>
    </el-card>
  </div>
</template>
