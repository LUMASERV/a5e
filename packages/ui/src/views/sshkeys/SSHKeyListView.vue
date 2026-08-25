<script setup lang="ts">
import ResourceListView from '../../components/ResourceListView.vue';
import { useNamespaceStore } from '../../stores/namespace';
import { useSSHKeyStore } from '../../stores/resources';

const namespaceStore = useNamespaceStore();
const store = useSSHKeyStore();
</script>

<template>
  <ResourceListView
    title="SSH Keys"
    :store="store"
    :namespaced="true"
    :namespace="namespaceStore.current"
    create-path="/sshkeys/new"
    resource-type="AnsibleSSHKey"
    :edit-path="(item) => `/sshkeys/${item.metadata.namespace}/${item.metadata.name}`"
  >
    <template #columns>
      <el-table-column label="Key type">
        <template #default="{ row }">{{ row.status?.keyType ?? '—' }}</template>
      </el-table-column>
    </template>
  </ResourceListView>
</template>
