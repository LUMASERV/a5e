<script setup lang="ts">
import type { AnsibleJobSpec, AnsibleJobStatus, CustomResource } from '@a5e/schemas';
import { ElMessage } from 'element-plus';
import { useRouter } from 'vue-router';
import { apiClient } from '../../api/client';
import ResourceListView from '../../components/ResourceListView.vue';
import { useNamespaceStore } from '../../stores/namespace';
import { useJobStore } from '../../stores/resources';

const router = useRouter();
const namespaceStore = useNamespaceStore();
const store = useJobStore();

async function triggerNow(row: CustomResource<AnsibleJobSpec, AnsibleJobStatus>) {
  try {
    const run = await apiClient.post<{ metadata: { namespace: string; name: string } }>(
      `/namespaces/${row.metadata.namespace}/ansiblejobs/${row.metadata.name}/trigger`,
    );
    ElMessage.success('Run started');
    router.push(`/runs/${run.metadata.namespace}/${run.metadata.name}`);
  } catch (err) {
    ElMessage.error((err as Error).message);
  }
}
</script>

<template>
  <ResourceListView
    title="Jobs"
    :store="store"
    :namespaced="true"
    :namespace="namespaceStore.current"
    create-path="/jobs/new"
    resource-type="AnsibleJob"
    :edit-path="(item) => `/jobs/${item.metadata.namespace}/${item.metadata.name}/edit`"
  >
    <template #columns>
      <el-table-column label="Schedule">
        <template #default="{ row }">{{ row.spec.schedule ?? 'manual only' }}</template>
      </el-table-column>
      <el-table-column label="Suspended" width="100">
        <template #default="{ row }">{{ row.spec.suspend ? 'yes' : 'no' }}</template>
      </el-table-column>
      <el-table-column label="Last schedule" width="200">
        <template #default="{ row }">{{ row.status?.lastScheduleTime ? new Date(row.status.lastScheduleTime).toLocaleString() : '—' }}</template>
      </el-table-column>
      <el-table-column label="Trigger" width="120">
        <template #default="{ row }">
          <el-button size="small" type="primary" @click.stop="triggerNow(row)">Run now</el-button>
        </template>
      </el-table-column>
    </template>
  </ResourceListView>
</template>
