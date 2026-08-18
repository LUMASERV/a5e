<script setup lang="ts">
import { useClusterPlaybookStore } from '../../stores/resources';
import ResourceListView from '../../components/ResourceListView.vue';

const store = useClusterPlaybookStore();
</script>

<template>
  <ResourceListView
    title="Cluster Playbooks"
    :store="store"
    :namespaced="false"
    create-path="/cluster-playbooks/new"
    :edit-path="(item) => `/cluster-playbooks/${item.metadata.name}/edit`"
  >
    <template #columns>
      <el-table-column label="Source">
        <template #default="{ row }">
          {{ row.spec.source.inline ? 'inline' : row.spec.source.configMapRef ? 'configMap' : 'git' }}
        </template>
      </el-table-column>
    </template>
  </ResourceListView>
</template>
