<script setup lang="ts">
import type { AnsibleHostSpec, AnsibleHostStatus, CustomResource } from '@a5e/schemas';
import { ElMessage } from 'element-plus';
import { ref } from 'vue';
import ResourceListView from '../../components/ResourceListView.vue';
import { useClusterHostStore } from '../../stores/resources';

const store = useClusterHostStore();

const enabledFilter = ref<'all' | 'enabled' | 'disabled'>('all');
function matchesEnabledFilter(item: CustomResource<unknown, unknown>): boolean {
  if (enabledFilter.value === 'all') return true;
  const enabled =
    (item as CustomResource<AnsibleHostSpec, AnsibleHostStatus>).spec.enabled !== false;
  return enabledFilter.value === 'enabled' ? enabled : !enabled;
}

async function toggleEnabled(
  row: CustomResource<AnsibleHostSpec, AnsibleHostStatus>,
  enabled: boolean,
) {
  try {
    await store.patch(row.metadata.name, { spec: { enabled } });
  } catch (err) {
    ElMessage.error((err as Error).message);
  }
}
</script>

<template>
  <ResourceListView
    title="Cluster Hosts"
    :store="store"
    :namespaced="false"
    create-path="/cluster-hosts/new"
    resource-type="ClusterAnsibleHost"
    :edit-path="(item) => `/cluster-hosts/${item.metadata.name}/edit`"
    :extra-filter="matchesEnabledFilter"
  >
    <template #filters>
      <el-select v-model="enabledFilter" style="width: 140px">
        <el-option label="All hosts" value="all" />
        <el-option label="Enabled only" value="enabled" />
        <el-option label="Disabled only" value="disabled" />
      </el-select>
    </template>
    <template #columns>
      <el-table-column label="Address">
        <template #default="{ row }">{{ row.spec.ansibleAddress ?? row.spec.ansibleHost ?? row.metadata.name }}</template>
      </el-table-column>
      <el-table-column label="Enabled" width="90">
        <template #default="{ row }">
          <el-switch :model-value="row.spec.enabled !== false" @click.stop @change="(v: boolean) => toggleEnabled(row, v)" />
        </template>
      </el-table-column>
    </template>
  </ResourceListView>
</template>
