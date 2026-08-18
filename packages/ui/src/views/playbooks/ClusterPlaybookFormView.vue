<script setup lang="ts">
import { onMounted, reactive } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { API_GROUP_VERSION } from '@a5e/schemas';
import type { AnsiblePlaybookSpec } from '@a5e/schemas';
import { useClusterPlaybookStore } from '../../stores/resources';
import PlaybookSourceEditor from '../../components/PlaybookSourceEditor.vue';

const props = defineProps<{ name?: string }>();
const router = useRouter();
const store = useClusterPlaybookStore();

const isEdit = Boolean(props.name);
const form = reactive<{ name: string; spec: AnsiblePlaybookSpec }>({
  name: props.name ?? '',
  spec: { source: { inline: { playbook: '' } } },
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
        kind: 'ClusterAnsiblePlaybook',
        metadata: { name: form.name },
        spec: form.spec,
      });
    }
    ElMessage.success('Saved');
    router.push('/cluster-playbooks');
  } catch (err) {
    ElMessage.error((err as Error).message);
  }
}
</script>

<template>
  <div>
    <h2>{{ isEdit ? 'Edit Cluster Playbook' : 'New Cluster Playbook' }}</h2>
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
