<script setup lang="ts">
import { onMounted, reactive } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { API_GROUP_VERSION } from '@a5e/schemas';
import type { AnsibleInventorySpec } from '@a5e/schemas';
import { useNamespaceStore } from '../../stores/namespace';
import { useInventoryStore } from '../../stores/resources';
import HostSourceListEditor from '../../components/HostSourceListEditor.vue';

const props = defineProps<{ namespace?: string; name?: string }>();
const router = useRouter();
const namespaceStore = useNamespaceStore();
const store = useInventoryStore();

const isEdit = Boolean(props.name);
const form = reactive<{ name: string; spec: AnsibleInventorySpec }>({
  name: props.name ?? '',
  spec: { groups: [] },
});

onMounted(async () => {
  if (isEdit && props.namespace && props.name) {
    const existing = await store.get(props.name, props.namespace);
    form.spec = existing.spec;
  }
});

async function save() {
  const namespace = isEdit ? props.namespace! : namespaceStore.current;
  try {
    if (isEdit) {
      const existing = await store.get(form.name, namespace);
      await store.update(form.name, { ...existing, spec: form.spec }, namespace);
    } else {
      await store.create(
        {
          apiVersion: API_GROUP_VERSION,
          kind: 'AnsibleInventory',
          metadata: { name: form.name, namespace },
          spec: form.spec,
        },
        namespace,
      );
    }
    ElMessage.success('Saved');
    router.push('/inventories');
  } catch (err) {
    ElMessage.error((err as Error).message);
  }
}
</script>

<template>
  <div>
    <h2>{{ isEdit ? 'Edit Inventory' : 'New Inventory' }}</h2>
    <el-form label-width="160px">
      <el-form-item label="Name">
        <el-input v-model="form.name" :disabled="isEdit" style="max-width: 400px" />
      </el-form-item>
      <el-form-item label="Groups">
        <HostSourceListEditor v-model="form.spec.groups" :namespaced="true" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" @click="save">Save</el-button>
      </el-form-item>
    </el-form>
  </div>
</template>
