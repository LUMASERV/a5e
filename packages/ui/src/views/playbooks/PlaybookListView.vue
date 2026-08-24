<script setup lang="ts">
import ResourceListView from '../../components/ResourceListView.vue';
import { useNamespaceStore } from '../../stores/namespace';
import { usePlaybookStore } from '../../stores/resources';

const namespaceStore = useNamespaceStore();
const store = usePlaybookStore();
</script>

<template>
  <ResourceListView
    title="Playbooks"
    :store="store"
    :namespaced="true"
    :namespace="namespaceStore.current"
    create-path="/playbooks/new"
    :edit-path="(item) => `/playbooks/${item.metadata.namespace}/${item.metadata.name}/edit`"
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
