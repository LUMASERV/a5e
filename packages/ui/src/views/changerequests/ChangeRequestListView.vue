<script setup lang="ts">
import type { ChangeRequestSpec, ChangeRequestStatus, CustomResource } from '@a5e/schemas';
import { computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useChangeRequestStore } from '../../stores/resources';

const router = useRouter();
const store = useChangeRequestStore();

function phaseType(phase?: string): 'success' | 'danger' | 'warning' | 'info' {
  if (phase === 'Applied') return 'success';
  if (phase === 'Declined' || phase === 'Failed') return 'danger';
  if (phase === 'Approved') return 'warning';
  return 'info';
}

// Pending first (practical stand-in for a "needs your review" indicator — computing that
// accurately would need duplicating the permission engine's matching logic client-side), then
// most recently requested.
const rows = computed(() =>
  Array.from(store.items.values()).sort((a, b) => {
    const aPending = (a.status?.phase ?? 'Pending') === 'Pending' ? 0 : 1;
    const bPending = (b.status?.phase ?? 'Pending') === 'Pending' ? 0 : 1;
    if (aPending !== bPending) return aPending - bPending;
    return new Date(b.spec.requestedAt).getTime() - new Date(a.spec.requestedAt).getTime();
  }),
);

onMounted(() => store.list());
onUnmounted(() => store.stop());
</script>

<template>
  <div>
    <h2>Change requests</h2>
    <el-table
      v-loading="store.loading"
      :data="rows"
      style="width: 100%"
      @row-click="(row: CustomResource<ChangeRequestSpec, ChangeRequestStatus>) => router.push(`/change-requests/${row.metadata.name}`)"
    >
      <el-table-column label="Requester">
        <template #default="{ row }">{{ row.spec.requestedByName }}</template>
      </el-table-column>
      <el-table-column label="Phase" width="120">
        <template #default="{ row }">
          <el-tag :type="phaseType(row.status?.phase)">{{ row.status?.phase ?? 'Pending' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="Items" width="80">
        <template #default="{ row }">{{ row.spec.changes.length }}</template>
      </el-table-column>
      <el-table-column label="Reason">
        <template #default="{ row }">{{ row.spec.reason ?? '—' }}</template>
      </el-table-column>
      <el-table-column label="Requested" width="200">
        <template #default="{ row }">{{ new Date(row.spec.requestedAt).toLocaleString() }}</template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
:deep(.el-table__row) {
  cursor: pointer;
}
</style>
