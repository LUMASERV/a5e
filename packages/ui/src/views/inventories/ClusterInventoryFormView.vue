<script setup lang="ts">
import { API_GROUP_VERSION } from '@a5e/schemas';
import type { AnsibleInventorySpec } from '@a5e/schemas';
import { ElMessage } from 'element-plus';
import { onMounted, reactive } from 'vue';
import { useRouter } from 'vue-router';
import HostSourceListEditor from '../../components/HostSourceListEditor.vue';
import { useClusterInventoryStore } from '../../stores/resources';

const props = defineProps<{ name?: string }>();
const router = useRouter();
const store = useClusterInventoryStore();

const isEdit = Boolean(props.name);
const form = reactive<{ name: string; spec: AnsibleInventorySpec }>({
  name: props.name ?? '',
  spec: { groups: [] },
});

onMounted(async () => {
  if (isEdit && props.name) {
    const existing = await store.get(props.name);
    form.spec = existing.spec;
  }
});

async function save() {
  try {
    if (isEdit) {
      const existing = await store.get(form.name);
      await store.update(form.name, { ...existing, spec: form.spec });
    } else {
      await store.create({
        apiVersion: API_GROUP_VERSION,
        kind: 'ClusterAnsibleInventory',
        metadata: { name: form.name },
        spec: form.spec,
      });
    }
    ElMessage.success('Saved');
    router.push('/cluster-inventories');
  } catch (err) {
    ElMessage.error((err as Error).message);
  }
}
</script>

<template>
  <div>
    <h2>{{ isEdit ? 'Edit Cluster Inventory' : 'New Cluster Inventory' }}</h2>
    <el-alert
      type="info"
      :closable="false"
      title="For a Cluster Inventory, AnsibleHost sources require an explicit namespace (no owning namespace to default to)."
      style="margin-bottom: 16px"
    />
    <el-form label-width="160px">
      <el-form-item label="Name">
        <el-input v-model="form.name" :disabled="isEdit" style="max-width: 400px" />
      </el-form-item>
      <el-form-item label="Groups">
        <HostSourceListEditor v-model="form.spec.groups" :namespaced="false" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" @click="save">Save</el-button>
      </el-form-item>
    </el-form>
  </div>
</template>
