<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { downloadFile } from '../../api/client';
import ResourceListView from '../../components/ResourceListView.vue';
import { useClusterInventoryStore } from '../../stores/resources';

const store = useClusterInventoryStore();

async function download(name: string) {
  try {
    await downloadFile(`/clusteransibleinventories/${name}/download`, `${name}.yaml`);
  } catch (err) {
    ElMessage.error((err as Error).message);
  }
}
</script>

<template>
  <ResourceListView
    title="Cluster Inventories"
    :store="store"
    :namespaced="false"
    create-path="/cluster-inventories/new"
    :edit-path="(item) => `/cluster-inventories/${item.metadata.name}/edit`"
  >
    <template #columns>
      <el-table-column label="Hosts">
        <template #default="{ row }">{{ row.status?.totalHosts ?? '—' }}</template>
      </el-table-column>
      <el-table-column label="Inventory file" width="160">
        <template #default="{ row }">
          <el-button size="small" @click.stop="download(row.metadata.name)">Download YAML</el-button>
        </template>
      </el-table-column>
    </template>
  </ResourceListView>
</template>
