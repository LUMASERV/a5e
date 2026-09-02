<script setup lang="ts">
import { API_GROUP_VERSION } from '@a5e/schemas';
import type { AnsibleHostSpec } from '@a5e/schemas';
import { ElMessage } from 'element-plus';
import { onMounted, reactive } from 'vue';
import { useRouter } from 'vue-router';
import JumpHostEditor from '../../components/JumpHostEditor.vue';
import LabelsEditor from '../../components/LabelsEditor.vue';
import ObjectRefPicker from '../../components/ObjectRefPicker.vue';
import VarsBySecretRefEditor from '../../components/VarsBySecretRefEditor.vue';
import VarsEditor from '../../components/VarsEditor.vue';
import { useChangeRequestDraftStore } from '../../stores/changeRequestDraft';
import { useNamespaceStore } from '../../stores/namespace';
import { useHostStore } from '../../stores/resources';

const props = defineProps<{ namespace?: string; name?: string }>();
const router = useRouter();
const namespaceStore = useNamespaceStore();
const store = useHostStore();
const draftStore = useChangeRequestDraftStore();

const isEdit = Boolean(props.name);
const form = reactive<{
  name: string;
  labels: Record<string, string> | undefined;
  spec: AnsibleHostSpec;
}>({
  name: props.name ?? '',
  labels: undefined,
  spec: { ansiblePort: 22, ansibleUser: 'root', enabled: true },
});
const formNamespace = props.namespace ?? namespaceStore.current;

onMounted(async () => {
  if (isEdit && props.namespace && props.name) {
    const existing = await store.get(props.name, props.namespace);
    form.spec = existing.spec;
    form.labels = existing.metadata.labels;
  }
});

async function save() {
  const namespace = isEdit ? props.namespace! : namespaceStore.current;
  const spec = {
    ...form.spec,
    sshKeyRef: form.spec.sshKeyRef?.name ? form.spec.sshKeyRef : undefined,
  };
  try {
    if (isEdit) {
      const existing = await store.get(form.name, namespace);
      await store.update(
        form.name,
        { ...existing, metadata: { ...existing.metadata, labels: form.labels }, spec },
        namespace,
        existing,
      );
    } else {
      await store.create(
        {
          apiVersion: API_GROUP_VERSION,
          kind: 'AnsibleHost',
          metadata: { name: form.name, namespace, labels: form.labels },
          spec,
        },
        namespace,
      );
    }
    ElMessage.success(draftStore.isActive ? 'Added to change request draft' : 'Saved');
    router.push('/hosts');
  } catch (err) {
    ElMessage.error((err as Error).message);
  }
}
</script>

<template>
  <div>
    <h2>{{ isEdit ? 'Edit Host' : 'New Host' }}</h2>
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
        <el-input v-model="form.spec.ansibleAddress" placeholder="IP or DNS — defaults to hostname" />
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
        :namespace="formNamespace"
        @update:model-value="(v) => (form.spec.sshKeyRef = v as AnsibleHostSpec['sshKeyRef'])"
      />
      <el-form-item label="Jump host">
        <JumpHostEditor v-model="form.spec.jumpHost" :namespace="formNamespace" parent-scope="namespaced" />
      </el-form-item>
      <el-form-item label="Vars from secrets">
        <VarsBySecretRefEditor v-model="form.spec.varsBySecretRef" :namespace-required="false" />
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
