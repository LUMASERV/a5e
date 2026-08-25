<script setup lang="ts">
import type { Permission } from '@a5e/schemas';
import { ElMessage } from 'element-plus';
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { apiClient } from '../api/client';
import PermissionsEditor from '../components/PermissionsEditor.vue';

interface Group {
  name: string;
  permissions: Permission[];
}

const props = defineProps<{ name: string }>();
const router = useRouter();
const loading = ref(true);
const saving = ref(false);
const permissions = ref<Permission[]>([]);

onMounted(async () => {
  try {
    const result = await apiClient.get<{ items: Group[] }>('/config/groups');
    const group = result.items.find((g) => g.name === props.name);
    permissions.value = group?.permissions ?? [];
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    loading.value = false;
  }
});

async function save() {
  saving.value = true;
  try {
    await apiClient.replace(`/config/groups/${encodeURIComponent(props.name)}`, {
      permissions: permissions.value,
    });
    ElMessage.success('Saved');
    router.push('/settings/groups');
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div v-loading="loading">
    <el-button link @click="router.push('/settings/groups')">← Back to Groups</el-button>
    <h2>Group — {{ name }}</h2>
    <PermissionsEditor v-model="permissions" />
    <div style="margin-top: 16px">
      <el-button type="primary" :loading="saving" @click="save">Save</el-button>
      <el-button @click="router.push('/settings/groups')">Cancel</el-button>
    </div>
  </div>
</template>
