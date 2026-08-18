<script setup lang="ts">
import { onMounted, reactive } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { API_GROUP_VERSION } from '@a5e/schemas';
import type { AnsibleHostSpec } from '@a5e/schemas';
import { useClusterHostStore } from '../../stores/resources';
import { useNamespaceStore } from '../../stores/namespace';
import JumpHostEditor from '../../components/JumpHostEditor.vue';
import LabelsEditor from '../../components/LabelsEditor.vue';
import ObjectRefPicker from '../../components/ObjectRefPicker.vue';
import VarsEditor from '../../components/VarsEditor.vue';

const props = defineProps<{ name?: string }>();
const router = useRouter();
const store = useClusterHostStore();
const namespaceStore = useNamespaceStore();

const isEdit = Boolean(props.name);
const form = reactive<{ name: string; labels: Record<string, string> | undefined; spec: AnsibleHostSpec }>({
  name: props.name ?? '',
  labels: undefined,
  spec: { ansiblePort: 22, ansibleUser: 'root', enabled: true },
});

onMounted(async () => {
  if (isEdit && props.name) {
    const existing = await store.get(props.name);
    form.spec = existing.spec;
    form.labels = existing.metadata.labels;
  }
});

async function save() {
  const spec = { ...form.spec, sshKeyRef: form.spec.sshKeyRef?.name ? form.spec.sshKeyRef : undefined };
  try {
    if (isEdit) {
      const existing = await store.get(form.name);
      await store.update(form.name, { ...existing, metadata: { ...existing.metadata, labels: form.labels }, spec });
    } else {
      await store.create({
        apiVersion: API_GROUP_VERSION,
        kind: 'ClusterAnsibleHost',
        metadata: { name: form.name, labels: form.labels },
        spec,
      });
    }
    ElMessage.success('Saved');
    router.push('/cluster-hosts');
  } catch (err) {
    ElMessage.error((err as Error).message);
  }
}
</script>

<template>
  <div>
    <h2>{{ isEdit ? 'Edit Cluster Host' : 'New Cluster Host' }}</h2>
    <el-form label-width="160px">
      <el-form-item label="Name">
        <el-input v-model="form.name" :disabled="isEdit" />
      </el-form-item>
      <el-form-item label="Labels">
        <LabelsEditor v-model="form.labels" />
      </el-form-item>
      <el-form-item label="Hostname">
        <el-input v-model="form.spec.ansibleHost" placeholder="defaults to name" />
      </el-form-item>
      <el-form-item label="Address">
        <el-input v-model="form.spec.ansibleAddress" />
      </el-form-item>
      <el-form-item label="Port">
        <el-input-number v-model="form.spec.ansiblePort" :min="1" :max="65535" />
      </el-form-item>
      <el-form-item label="User">
        <el-input v-model="form.spec.ansibleUser" />
      </el-form-item>
      <ObjectRefPicker
        :model-value="form.spec.sshKeyRef ?? { kind: 'AnsibleSSHKey', name: '' }"
        label="SSH Key"
        namespaced-kind="AnsibleSSHKey"
        cluster-kind="ClusterAnsibleSSHKey"
        :namespace="namespaceStore.current"
        parent-scope="cluster"
        @update:model-value="(v) => (form.spec.sshKeyRef = v as AnsibleHostSpec['sshKeyRef'])"
      />
      <el-form-item label="Jump host">
        <JumpHostEditor v-model="form.spec.jumpHost" :namespace="namespaceStore.current" parent-scope="cluster" />
      </el-form-item>
      <el-form-item label="Vars (YAML)">
        <VarsEditor v-model="form.spec.vars" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" @click="save">Save</el-button>
      </el-form-item>
    </el-form>
  </div>
</template>
