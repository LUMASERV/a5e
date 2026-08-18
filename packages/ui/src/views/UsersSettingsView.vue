<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { apiClient } from '../api/client';

interface AppUser {
  id: string;
  username?: string;
  sub?: string;
  email?: string;
  displayName?: string;
  impersonateGroups: string[];
  role: 'none' | 'user' | 'admin';
  hasPassword: boolean;
}

const users = ref<AppUser[]>([]);
const loading = ref(true);
const creating = ref(false);

const form = reactive({ username: '', password: '', email: '', displayName: '', groupsText: '', role: 'user' });

async function load() {
  loading.value = true;
  try {
    const result = await apiClient.get<{ items: AppUser[] }>('/config/users');
    users.value = result.items;
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    loading.value = false;
  }
}

async function create() {
  if (!form.username.trim() || !form.password) {
    ElMessage.error('Username and password are required');
    return;
  }
  creating.value = true;
  try {
    await apiClient.create('/config/users', {
      username: form.username.trim(),
      password: form.password,
      email: form.email.trim() || undefined,
      displayName: form.displayName.trim() || undefined,
      impersonateGroups: form.groupsText
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean),
      role: form.role,
    });
    Object.assign(form, { username: '', password: '', email: '', displayName: '', groupsText: '', role: 'user' });
    ElMessage.success('Created');
    await load();
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    creating.value = false;
  }
}

async function setRole(id: string, role: string) {
  try {
    await apiClient.patch(`/config/users/${encodeURIComponent(id)}`, { role });
    ElMessage.success('Updated');
    await load();
  } catch (err) {
    ElMessage.error((err as Error).message);
  }
}

async function remove(user: AppUser) {
  const label = user.username ?? user.email ?? user.sub ?? user.id;
  try {
    await ElMessageBox.confirm(`Remove "${label}"?`, 'Confirm', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await apiClient.remove(`/config/users/${encodeURIComponent(user.id)}`);
    ElMessage.success('Removed');
    await load();
  } catch (err) {
    ElMessage.error((err as Error).message);
  }
}

onMounted(load);
</script>

<template>
  <div>
    <h2>Users</h2>
    <p style="color: var(--el-text-color-secondary); max-width: 700px">
      Every identity that can log in: local username/password accounts, and SSO identities that
      have logged in at least once. A local account whose email matches an SSO login gets linked
      automatically (needs the "email" scope enabled in OIDC settings) and shows as a single row
      with both a username and an SSO identity — everyone else has just one or the other. New
      identities appear here with role "none" on first SSO login, or must be created below for
      local login.
    </p>

    <el-table v-loading="loading" :data="users" style="width: 100%; max-width: 1000px; margin-bottom: 24px">
      <el-table-column label="Username" width="140">
        <template #default="{ row }">{{ row.username ?? '—' }}</template>
      </el-table-column>
      <el-table-column label="SSO identity">
        <template #default="{ row }">
          <span v-if="row.sub" style="font-family: monospace; font-size: 12px">{{ row.sub }}</span>
          <span v-else>—</span>
        </template>
      </el-table-column>
      <el-table-column label="Name / Email">
        <template #default="{ row }">{{ row.displayName ?? row.email ?? '—' }}</template>
      </el-table-column>
      <el-table-column label="Groups">
        <template #default="{ row }">{{ row.impersonateGroups.join(', ') || '—' }}</template>
      </el-table-column>
      <el-table-column label="Role" width="120">
        <template #default="{ row }">
          <el-select :model-value="row.role" style="width: 100px" @update:model-value="(v: string) => setRole(row.id, v)">
            <el-option label="none" value="none" />
            <el-option label="user" value="user" />
            <el-option label="admin" value="admin" />
          </el-select>
        </template>
      </el-table-column>
      <el-table-column label="Actions" width="100">
        <template #default="{ row }">
          <el-button size="small" type="danger" @click="remove(row)">Remove</el-button>
        </template>
      </el-table-column>
    </el-table>

    <h3>New local account</h3>
    <el-form label-width="160px" style="max-width: 700px">
      <el-form-item label="Username">
        <el-input v-model="form.username" />
      </el-form-item>
      <el-form-item label="Password">
        <el-input v-model="form.password" type="password" show-password />
      </el-form-item>
      <el-form-item label="Email">
        <el-input v-model="form.email" placeholder="for SSO account linking, optional" />
      </el-form-item>
      <el-form-item label="Display name">
        <el-input v-model="form.displayName" placeholder="defaults to username" />
      </el-form-item>
      <el-form-item label="Groups">
        <el-input v-model="form.groupsText" placeholder="comma-separated, e.g. a5e-admins" />
      </el-form-item>
      <el-form-item label="Role">
        <el-select v-model="form.role" style="width: 120px">
          <el-option label="none" value="none" />
          <el-option label="user" value="user" />
          <el-option label="admin" value="admin" />
        </el-select>
      </el-form-item>
      <el-form-item>
        <el-button type="primary" :loading="creating" @click="create">Create</el-button>
      </el-form-item>
    </el-form>
  </div>
</template>
