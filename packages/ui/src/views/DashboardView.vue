<script setup lang="ts">
import type { CustomResource } from '@a5e/schemas';
import { computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useNamespaceStore } from '../stores/namespace';
import {
  useHostStore,
  useInventoryStore,
  usePlaybookStore,
  useRunStore,
  useSSHKeyStore,
} from '../stores/resources';

const router = useRouter();
const namespaceStore = useNamespaceStore();
const hostStore = useHostStore();
const inventoryStore = useInventoryStore();
const playbookStore = usePlaybookStore();
const sshKeyStore = useSSHKeyStore();
const runStore = useRunStore();

const recentRuns = computed(() =>
  Array.from(runStore.items.values())
    .sort(
      (a, b) =>
        new Date(b.metadata.creationTimestamp ?? 0).getTime() -
        new Date(a.metadata.creationTimestamp ?? 0).getTime(),
    )
    .slice(0, 10),
);

function phaseType(phase?: string): 'success' | 'danger' | 'warning' | 'info' {
  if (phase === 'Succeeded') return 'success';
  if (phase === 'Failed' || phase === 'Error') return 'danger';
  if (phase === 'Running' || phase === 'Resolving') return 'warning';
  return 'info';
}

function openRun(row: CustomResource<unknown, unknown>) {
  router.push(`/runs/${row.metadata.namespace}/${row.metadata.name}`);
}

onMounted(() => {
  const ns = namespaceStore.current;
  hostStore.list(ns);
  inventoryStore.list(ns);
  playbookStore.list(ns);
  sshKeyStore.list(ns);
  runStore.list(ns);
});
onUnmounted(() => {
  hostStore.stop();
  inventoryStore.stop();
  playbookStore.stop();
  sshKeyStore.stop();
  runStore.stop();
});
</script>

<template>
  <div>
    <h2>Dashboard</h2>
    <el-row :gutter="16" style="margin-bottom: 24px">
      <el-col :span="6">
        <el-statistic title="Hosts" :value="hostStore.items.size" />
      </el-col>
      <el-col :span="6">
        <el-statistic title="Inventories" :value="inventoryStore.items.size" />
      </el-col>
      <el-col :span="6">
        <el-statistic title="Playbooks" :value="playbookStore.items.size" />
      </el-col>
      <el-col :span="6">
        <el-statistic title="SSH Keys" :value="sshKeyStore.items.size" />
      </el-col>
    </el-row>

    <h3>Recent runs</h3>
    <el-table :data="recentRuns" style="cursor: pointer" @row-click="openRun">
      <el-table-column prop="metadata.name" label="Name" />
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
