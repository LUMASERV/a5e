<script setup lang="ts">
import type { Permission } from '@a5e/schemas';
import { ElMessage } from 'element-plus';
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { apiClient } from '../api/client';
import PermissionsEditor from '../components/PermissionsEditor.vue';

interface AppUser {
  id: string;
  username?: string;
  sub?: string;
  email?: string;
  displayName?: string;
  impersonateGroups: string[];
  role: 'none' | 'user' | 'admin';
  permissions: Permission[];
}

const props = defineProps<{ id: string }>();
const router = useRouter();
const loading = ref(true);
const saving = ref(false);
const knownGroups = ref<string[]>([]);
const label = ref('');

const form = reactive({
  isPromotion: false,
  username: '',
  email: '',
  displayName: '',
  groups: [] as string[],
  role: 'user' as 'none' | 'user' | 'admin',
  password: '',
  permissions: [] as Permission[],
});

async function loadKnownGroups() {
  try {
    const result = await apiClient.get<{ items: { name: string }[] }>('/config/groups');
    knownGroups.value = result.items.map((g) => g.name);
  } catch {
    // Non-fatal — the group picker just falls back to allow-create-only if this fails.
  }
}

onMounted(async () => {
  loadKnownGroups();
  try {
    const result = await apiClient.get<{ items: AppUser[] }>('/config/users');
    const user = result.items.find((u) => u.id === props.id);
    if (!user) {
      ElMessage.error('User not found');
      router.push('/settings/users');
      return;
    }
    label.value = user.username ?? user.email ?? user.id;
    form.isPromotion = !user.username;
    form.username = user.username ?? '';
    form.email = user.email ?? '';
    form.displayName = user.displayName ?? '';
    form.groups = [...user.impersonateGroups];
    form.role = user.role;
    form.permissions = [...(user.permissions ?? [])];
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    loading.value = false;
  }
});

async function save() {
  if (form.isPromotion && !form.username.trim()) {
    ElMessage.error('Username is required to give this identity a local account');
    return;
  }
  saving.value = true;
  try {
    await apiClient.patch(`/config/users/${encodeURIComponent(props.id)}`, {
      username: form.isPromotion ? form.username.trim() : undefined,
      email: form.email.trim(),
      displayName: form.displayName.trim(),
      impersonateGroups: form.groups,
      role: form.role,
      password: form.password || undefined,
      permissions: form.permissions,
    });
    ElMessage.success('Saved');
    router.push('/settings/users');
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div v-loading="loading">
    <el-button link @click="router.push('/settings/users')">← Back to Users</el-button>
    <h2>Edit user — {{ label }}</h2>

    <el-form label-width="140px" style="max-width: 600px">
      <el-form-item v-if="form.isPromotion" label="Username">
        <el-input v-model="form.username" placeholder="required to give this SSO identity a local account" />
      </el-form-item>
      <el-form-item v-else label="Username">
        <el-input :model-value="form.username" disabled />
      </el-form-item>
      <el-form-item label="Email">
        <el-input v-model="form.email" placeholder="for SSO account linking" />
      </el-form-item>
      <el-form-item label="Display name">
        <el-input v-model="form.displayName" />
      </el-form-item>
      <el-form-item label="Groups">
        <el-select v-model="form.groups" multiple filterable allow-create default-first-option style="width: 100%">
          <el-option v-for="g in knownGroups" :key="g" :label="g" :value="g" />
        </el-select>
      </el-form-item>
      <el-form-item label="Role">
        <el-select v-model="form.role" style="width: 120px">
          <el-option label="none" value="none" />
          <el-option label="user" value="user" />
          <el-option label="admin" value="admin" />
        </el-select>
      </el-form-item>
      <el-form-item label="New password">
        <el-input
          v-model="form.password"
          type="password"
          show-password
          :placeholder="form.isPromotion ? 'optional — leave blank to promote without one yet' : 'leave blank to keep unchanged'"
        />
      </el-form-item>
    </el-form>

    <!-- Full page width, deliberately not sharing a row with the form above: the permission list
         can have many entries, each with its own Type/Namespaces/Labels/Actions row, and needs the
         room. -->
    <h3>Permissions</h3>
    <el-alert
      v-if="form.role === 'admin'"
      type="info"
      :closable="false"
      show-icon
      style="margin-bottom: 12px"
      title="Admins bypass the permission system entirely and always have full access — any rules set below have no effect while this account's role is admin."
    />
    <PermissionsEditor v-model="form.permissions" :disabled="form.role === 'admin'" />

    <div style="margin-top: 16px">
      <el-button type="primary" :loading="saving" @click="save">Save</el-button>
      <el-button @click="router.push('/settings/users')">Cancel</el-button>
    </div>
  </div>
</template>
