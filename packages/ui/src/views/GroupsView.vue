<script setup lang="ts">
import type { Permission } from '@a5e/schemas';
import { ElMessage, ElMessageBox } from 'element-plus';
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { apiClient } from '../api/client';

interface Group {
  name: string;
  permissions: Permission[];
}

const router = useRouter();
const groups = ref<Group[]>([]);
const loading = ref(true);

async function load() {
  loading.value = true;
  try {
    const result = await apiClient.get<{ items: Group[] }>('/config/groups');
    groups.value = result.items;
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    loading.value = false;
  }
}

async function remove(group: Group) {
  try {
    await ElMessageBox.confirm(`Remove group "${group.name}"?`, 'Confirm', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await apiClient.remove(`/config/groups/${encodeURIComponent(group.name)}`);
    ElMessage.success('Removed');
    await load();
  } catch (err) {
    ElMessage.error((err as Error).message);
  }
}

// --- Create dialog — a modal deliberately: it's a single name field, unlike editing (see
// GroupEditView.vue, a full page precisely because that one holds the Permissions editor). ---
const createDialogVisible = ref(false);
const creating = ref(false);
const newGroupName = ref('');

function openCreate() {
  newGroupName.value = '';
  createDialogVisible.value = true;
}

async function create() {
  const name = newGroupName.value.trim();
  if (!name) {
    ElMessage.error('Group name is required');
    return;
  }
  creating.value = true;
  try {
    await apiClient.replace(`/config/groups/${encodeURIComponent(name)}`, { permissions: [] });
    createDialogVisible.value = false;
    router.push(`/settings/groups/${encodeURIComponent(name)}/edit`);
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
      <h2 style="margin: 0">Groups</h2>
      <el-button type="primary" @click="openCreate">New Group</el-button>
    </div>
    <p style="color: var(--el-text-color-secondary)">
      A named set of permission grants that a local user or an OIDC group claim can reference by
      name (see Users → Groups) — define one here once, then assign it to everyone who needs it
      instead of granting the same permissions individually.
    </p>

    <el-table v-loading="loading" :data="groups" style="width: 100%">
      <el-table-column prop="name" label="Group" />
      <el-table-column label="Rules" width="100">
        <template #default="{ row }">{{ row.permissions.length }}</template>
      </el-table-column>
      <el-table-column label="Actions" width="150">
        <template #default="{ row }">
          <el-button size="small" @click="router.push(`/settings/groups/${encodeURIComponent(row.name)}/edit`)">Edit</el-button>
          <el-button size="small" type="danger" @click="remove(row)">Remove</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="createDialogVisible" title="New Group" width="480px">
      <el-form label-width="120px" @submit.prevent="create">
        <el-form-item label="Name">
          <el-input v-model="newGroupName" @keyup.enter="create" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialogVisible = false">Cancel</el-button>
        <el-button type="primary" :loading="creating" @click="create">Create</el-button>
      </template>
    </el-dialog>
  </div>
</template>
