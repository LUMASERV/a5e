<script setup lang="ts">
import { API_GROUP_VERSION } from '@a5e/schemas';
import type { AnsiblePlaybookSpec } from '@a5e/schemas';
import { ElMessage } from 'element-plus';
import { onMounted, reactive } from 'vue';
import { useRouter } from 'vue-router';
import PlaybookSourceEditor from '../../components/PlaybookSourceEditor.vue';
import { useNamespaceStore } from '../../stores/namespace';
import { usePlaybookStore } from '../../stores/resources';

const props = defineProps<{ namespace?: string; name?: string }>();
const router = useRouter();
const namespaceStore = useNamespaceStore();
const store = usePlaybookStore();

const isEdit = Boolean(props.name);
const form = reactive<{ name: string; spec: AnsiblePlaybookSpec }>({
  name: props.name ?? '',
  spec: { source: { inline: { playbook: '' } } },
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
          kind: 'AnsiblePlaybook',
          metadata: { name: form.name, namespace },
          spec: form.spec,
        },
        namespace,
      );
    }
    ElMessage.success('Saved');
    router.push('/playbooks');
  } catch (err) {
    ElMessage.error((err as Error).message);
  }
}
</script>

<template>
  <div>
    <h2>{{ isEdit ? 'Edit Playbook' : 'New Playbook' }}</h2>
    <el-form label-width="160px">
      <el-form-item label="Name">
        <el-input v-model="form.name" :disabled="isEdit" />
      </el-form-item>
      <el-form-item label="Entry point">
        <el-input v-model="form.spec.entryPoint" placeholder="playbook.yml" />
      </el-form-item>
      <el-form-item label="Source">
        <PlaybookSourceEditor v-model="form.spec.source" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" @click="save">Save</el-button>
      </el-form-item>
    </el-form>
  </div>
</template>
