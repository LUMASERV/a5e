<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { downloadFile } from '../../api/client';
import ResourceListView from '../../components/ResourceListView.vue';
import { useNamespaceStore } from '../../stores/namespace';
import { useInventoryStore } from '../../stores/resources';

const namespaceStore = useNamespaceStore();
const store = useInventoryStore();

async function download(namespace: string, name: string) {
  try {
    await downloadFile(
      `/namespaces/${namespace}/ansibleinventories/${name}/download`,
      `${name}.yaml`,
    );
  } catch (err) {
    ElMessage.error((err as Error).message);
  }
}
</script>

<template>
  <ResourceListView
    title="Inventories"
    :store="store"
    :namespaced="true"
    :namespace="namespaceStore.current"
    create-path="/inventories/new"
    resource-type="AnsibleInventory"
    :edit-path="(item) => `/inventories/${item.metadata.namespace}/${item.metadata.name}/edit`"
  >
    <template #columns>
      <el-table-column label="Hosts">
        <template #default="{ row }">{{ row.status?.totalHosts ?? '—' }}</template>
      </el-table-column>
      <el-table-column label="Inventory file" width="160">
        <template #default="{ row }">
          <el-button size="small" @click.stop="download(row.metadata.namespace, row.metadata.name)">
            Download YAML
          </el-button>
        </template>
      </el-table-column>
    </template>
  </ResourceListView>
</template>
