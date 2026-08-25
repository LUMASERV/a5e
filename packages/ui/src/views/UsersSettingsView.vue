<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus';
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
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

const router = useRouter();
const users = ref<AppUser[]>([]);
const loading = ref(true);
const knownGroups = ref<string[]>([]);

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

async function loadKnownGroups() {
  try {
    const result = await apiClient.get<{ items: { name: string }[] }>('/config/groups');
    knownGroups.value = result.items.map((g) => g.name);
  } catch {
    // Non-fatal — the group picker just falls back to allow-create-only if this fails.
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

// --- Create dialog — kept as a modal deliberately: it's a short, fixed set of fields with no
// Permissions editor, unlike editing (see UserEditView.vue, a full page precisely because that one
// does need the room). ---
const createDialogVisible = ref(false);
const creating = ref(false);
const createForm = reactive({
  username: '',
  password: '',
  email: '',
  displayName: '',
  groups: [] as string[],
  role: 'user',
});

function openCreate() {
  Object.assign(createForm, {
    username: '',
    password: '',
    email: '',
    displayName: '',
    groups: [],
    role: 'user',
  });
  createDialogVisible.value = true;
  loadKnownGroups();
}

async function create() {
  if (!createForm.username.trim()) {
    ElMessage.error('Username is required');
    return;
  }
  if (!createForm.password && !createForm.email.trim()) {
    ElMessage.error('Either a password or an email (for SSO account linking) is required');
    return;
  }
  creating.value = true;
  try {
    await apiClient.create('/config/users', {
      username: createForm.username.trim(),
      password: createForm.password || undefined,
      email: createForm.email.trim() || undefined,
      displayName: createForm.displayName.trim() || undefined,
      impersonateGroups: createForm.groups,
      role: createForm.role,
    });
    ElMessage.success('Created');
    createDialogVisible.value = false;
    await load();
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    creating.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px">
      <h2 style="margin: 0">Users</h2>
      <el-button type="primary" @click="openCreate">New User</el-button>
    </div>
    <p style="color: var(--el-text-color-secondary)">
      Every identity that can log in: local username/password accounts, and SSO identities that
      have logged in at least once. A local account whose email matches an SSO login gets linked
      automatically (needs the "email" scope enabled in OIDC settings) and shows as a single row
      with both a username and an SSO identity — everyone else has just one or the other. New
      identities appear here with role "none" on first SSO login. Editing an SSO-only row lets you
      give it a username, turning it into a real local account it can be given a password for.
    </p>

    <el-table v-loading="loading" :data="users" style="width: 100%">
      <el-table-column label="Username" width="140">
        <template #default="{ row }">{{ row.username ?? '—' }}</template>
      </el-table-column>
      <el-table-column label="SSO identity">
        <template #default="{ row }">
          <span v-if="row.sub" style="font-family: monospace; font-size: 12px">{{ row.sub }}</span>
          <span v-else>—</span>
        </template>
      </el-table-column>
      <el-table-column label="Name">
        <template #default="{ row }">{{ row.displayName ?? '—' }}</template>
      </el-table-column>
      <el-table-column label="Email">
        <template #default="{ row }">{{ row.email ?? '—' }}</template>
      </el-table-column>
      <el-table-column label="Groups">
        <template #default="{ row }">{{ row.impersonateGroups.join(', ') || '—' }}</template>
      </el-table-column>
      <el-table-column label="Password" width="90">
        <template #default="{ row }">
          <el-tag v-if="row.username" :type="row.hasPassword ? 'success' : 'info'" size="small">
            {{ row.hasPassword ? 'set' : 'none' }}
          </el-tag>
          <span v-else>—</span>
        </template>
      </el-table-column>
      <el-table-column label="Role" width="90">
        <template #default="{ row }">
          <el-tag :type="row.role === 'admin' ? 'danger' : row.role === 'user' ? 'success' : 'info'" size="small">
            {{ row.role }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="Actions" width="150">
        <template #default="{ row }">
          <el-button size="small" @click="router.push(`/settings/users/${encodeURIComponent(row.id)}/edit`)">Edit</el-button>
          <el-button size="small" type="danger" @click="remove(row)">Remove</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="createDialogVisible" title="New User" width="520px">
      <el-form label-width="140px">
        <el-form-item label="Username">
          <el-input v-model="createForm.username" />
        </el-form-item>
        <el-form-item label="Password">
          <el-input v-model="createForm.password" type="password" show-password placeholder="optional — see note above" />
        </el-form-item>
        <el-form-item label="Email">
          <el-input v-model="createForm.email" placeholder="for SSO account linking, optional" />
        </el-form-item>
        <el-form-item label="Display name">
          <el-input v-model="createForm.displayName" placeholder="defaults to username" />
        </el-form-item>
        <el-form-item label="Groups">
          <el-select v-model="createForm.groups" multiple filterable allow-create default-first-option style="width: 100%">
            <el-option v-for="g in knownGroups" :key="g" :label="g" :value="g" />
          </el-select>
        </el-form-item>
        <el-form-item label="Role">
          <el-select v-model="createForm.role" style="width: 120px">
            <el-option label="none" value="none" />
            <el-option label="user" value="user" />
            <el-option label="admin" value="admin" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialogVisible = false">Cancel</el-button>
        <el-button type="primary" :loading="creating" @click="create">Create</el-button>
      </template>
    </el-dialog>
  </div>
</template>
