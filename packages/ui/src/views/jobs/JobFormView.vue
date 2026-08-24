<script setup lang="ts">
import { API_GROUP_VERSION } from '@a5e/schemas';
import type { AnsibleJobSpec } from '@a5e/schemas';
import { ElMessage } from 'element-plus';
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import YAML from 'yaml';
import ObjectRefPicker from '../../components/ObjectRefPicker.vue';
import { useNamespaceStore } from '../../stores/namespace';
import { useJobStore } from '../../stores/resources';

const props = defineProps<{ namespace?: string; name?: string }>();
const router = useRouter();
const namespaceStore = useNamespaceStore();
const store = useJobStore();

const isEdit = Boolean(props.name);
const formNamespace = props.namespace ?? namespaceStore.current;
const extraVarsText = ref('');

const form = reactive<{ name: string; spec: AnsibleJobSpec }>({
  name: props.name ?? '',
  spec: {
    template: {
      playbookRef: { kind: 'AnsiblePlaybook', name: '' },
      inventoryRef: { kind: 'AnsibleInventory', name: '' },
    },
    suspend: false,
    concurrencyPolicy: 'Allow',
    successfulRunsHistoryLimit: 3,
    failedRunsHistoryLimit: 1,
  },
});

onMounted(async () => {
  if (isEdit && props.namespace && props.name) {
    const existing = await store.get(props.name, props.namespace);
    form.spec = existing.spec;
    extraVarsText.value = existing.spec.template.extraVars
      ? YAML.stringify(existing.spec.template.extraVars)
      : '';
  }
});

async function save() {
  let extraVars: Record<string, unknown> | undefined;
  try {
    extraVars = extraVarsText.value.trim() ? YAML.parse(extraVarsText.value) : undefined;
  } catch (err) {
    ElMessage.error(`Extra vars must be valid YAML: ${(err as Error).message}`);
    return;
  }

  const namespace = isEdit ? props.namespace! : namespaceStore.current;
  const spec: AnsibleJobSpec = { ...form.spec, template: { ...form.spec.template, extraVars } };
  try {
    if (isEdit) {
      const existing = await store.get(form.name, namespace);
      await store.update(form.name, { ...existing, spec }, namespace);
    } else {
      await store.create(
        {
          apiVersion: API_GROUP_VERSION,
          kind: 'AnsibleJob',
          metadata: { name: form.name, namespace },
          spec,
        },
        namespace,
      );
    }
    ElMessage.success('Saved');
    router.push('/jobs');
  } catch (err) {
    ElMessage.error((err as Error).message);
  }
}
</script>

<template>
  <div>
    <h2>{{ isEdit ? 'Edit Job' : 'New Job' }}</h2>
    <el-form label-width="200px">
      <el-form-item label="Name">
        <el-input v-model="form.name" :disabled="isEdit" style="max-width: 400px" />
      </el-form-item>

      <ObjectRefPicker
        v-model="form.spec.template.playbookRef"
        label="Playbook"
        namespaced-kind="AnsiblePlaybook"
        cluster-kind="ClusterAnsiblePlaybook"
        :namespace="formNamespace"
      />
      <ObjectRefPicker
        v-model="form.spec.template.inventoryRef"
        label="Inventory"
        namespaced-kind="AnsibleInventory"
        cluster-kind="ClusterAnsibleInventory"
        :namespace="formNamespace"
      />
      <el-form-item label="Extra vars (YAML)">
        <el-input v-model="extraVarsText" type="textarea" :rows="4" placeholder="key: value" />
      </el-form-item>

      <el-form-item label="Schedule (cron)">
        <el-input v-model="form.spec.schedule" placeholder="e.g. 0 3 * * * — omit for manual-trigger only" style="max-width: 400px" />
      </el-form-item>
      <el-form-item label="Suspend">
        <el-switch v-model="form.spec.suspend" />
      </el-form-item>
      <el-form-item label="Concurrency policy">
        <el-radio-group v-model="form.spec.concurrencyPolicy">
          <el-radio-button value="Allow">Allow</el-radio-button>
          <el-radio-button value="Forbid">Forbid</el-radio-button>
          <el-radio-button value="Replace">Replace</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="Successful runs to keep">
        <el-input-number v-model="form.spec.successfulRunsHistoryLimit" :min="0" />
      </el-form-item>
      <el-form-item label="Failed runs to keep">
        <el-input-number v-model="form.spec.failedRunsHistoryLimit" :min="0" />
      </el-form-item>

      <el-form-item>
        <el-button type="primary" @click="save">Save</el-button>
      </el-form-item>
    </el-form>
  </div>
</template>
