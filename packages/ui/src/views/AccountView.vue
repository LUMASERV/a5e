<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { reactive, ref } from 'vue';
import { apiClient } from '../api/client';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const saving = ref(false);

const form = reactive({
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
});

async function changePassword() {
  if (form.newPassword.length < 8) {
    ElMessage.error('New password must be at least 8 characters');
    return;
  }
  if (form.newPassword !== form.confirmPassword) {
    ElMessage.error('New password and confirmation do not match');
    return;
  }
  saving.value = true;
  try {
    await apiClient.post('/auth/me/password', {
      currentPassword: form.currentPassword || undefined,
      newPassword: form.newPassword,
    });
    ElMessage.success('Password updated');
    form.currentPassword = '';
    form.newPassword = '';
    form.confirmPassword = '';
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div style="max-width: 500px">
    <h2>My account</h2>
    <el-descriptions :column="1" border style="margin-bottom: 24px">
      <el-descriptions-item label="Signed in as">{{ auth.session?.displayName }}</el-descriptions-item>
      <el-descriptions-item label="Identity">{{ auth.session?.identity.impersonateUser }}</el-descriptions-item>
      <el-descriptions-item label="Role">{{ auth.role }}</el-descriptions-item>
    </el-descriptions>

    <template v-if="auth.session?.identity.impersonateUser.startsWith('local:')">
      <h3>Change password</h3>
      <el-form label-width="160px" @submit.prevent="changePassword">
        <el-form-item label="Current password">
          <el-input
            v-model="form.currentPassword"
            type="password"
            show-password
            placeholder="leave blank if none set yet"
          />
        </el-form-item>
        <el-form-item label="New password">
          <el-input v-model="form.newPassword" type="password" show-password />
        </el-form-item>
        <el-form-item label="Confirm new password">
          <el-input
            v-model="form.confirmPassword"
            type="password"
            show-password
            @keyup.enter="changePassword"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="saving" @click="changePassword">Update password</el-button>
        </el-form-item>
      </el-form>
    </template>
    <el-alert
      v-else
      type="info"
      :closable="false"
      title="You're signed in via SSO — there's no local password to change here."
    />
  </div>
</template>
