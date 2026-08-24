<script setup lang="ts">
import type { AnsibleRunSpec, AnsibleRunStatus, CustomResource } from '@a5e/schemas';
import { computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useNamespaceStore } from '../../stores/namespace';
import { useRunStore } from '../../stores/resources';

const router = useRouter();
const namespaceStore = useNamespaceStore();
const store = useRunStore();

const rows = computed(() =>
  Array.from(store.items.values()).sort(
    (a, b) =>
      new Date(b.metadata.creationTimestamp ?? 0).getTime() -
      new Date(a.metadata.creationTimestamp ?? 0).getTime(),
  ),
);

function phaseType(phase?: string): 'success' | 'danger' | 'warning' | 'info' {
  if (phase === 'Succeeded') return 'success';
  if (phase === 'Failed' || phase === 'Error') return 'danger';
  if (phase === 'Running' || phase === 'Resolving') return 'warning';
  return 'info';
}

onMounted(() => store.list(namespaceStore.current));
onUnmounted(() => store.stop());
</script>

<template>
  <div>
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px">
      <h2 style="margin: 0">Runs</h2>
      <el-button type="primary" @click="router.push('/runs/new')">New run</el-button>
    </div>
    <el-table
      v-loading="store.loading"
      :data="rows"
      style="width: 100%"
      @row-click="(row: CustomResource<AnsibleRunSpec, AnsibleRunStatus>) => router.push(`/runs/${row.metadata.namespace}/${row.metadata.name}`)"
    >
      <el-table-column prop="metadata.name" label="Name" />
      <el-table-column label="Playbook">
        <template #default="{ row }">{{ row.spec.playbookRef.name }}</template>
      </el-table-column>
      <el-table-column label="Phase" width="140">
        <template #default="{ row }">
          <el-tag :type="phaseType(row.status?.phase)">{{ row.status?.phase ?? 'Pending' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="Started" width="200">
        <template #default="{ row }">{{ row.status?.startTime ? new Date(row.status.startTime).toLocaleString() : '—' }}</template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
:deep(.el-table__row) {
  cursor: pointer;
}
</style>
