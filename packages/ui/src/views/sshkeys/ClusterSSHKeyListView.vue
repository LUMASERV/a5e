<script setup lang="ts">
import { useClusterSSHKeyStore } from '../../stores/resources';
import ResourceListView from '../../components/ResourceListView.vue';

const store = useClusterSSHKeyStore();
</script>

<template>
  <ResourceListView
    title="Cluster SSH Keys"
    :store="store"
    :namespaced="false"
    create-path="/cluster-sshkeys/new"
    :edit-path="(item) => `/cluster-sshkeys/${item.metadata.name}`"
  >
    <template #columns>
      <el-table-column label="Key type">
        <template #default="{ row }">{{ row.status?.keyType ?? '—' }}</template>
      </el-table-column>
    </template>
  </ResourceListView>
</template>
