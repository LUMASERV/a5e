<script setup lang="ts">
import { API_GROUP_VERSION } from '@a5e/schemas';
import type { AnsibleRunSpec } from '@a5e/schemas';
import { ElMessage } from 'element-plus';
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import YAML from 'yaml';
import ObjectRefPicker from '../../components/ObjectRefPicker.vue';
import { useNamespaceStore } from '../../stores/namespace';
import { useRunStore } from '../../stores/resources';

const router = useRouter();
const namespaceStore = useNamespaceStore();
const store = useRunStore();

const extraVarsText = ref('');
const form = reactive<AnsibleRunSpec>({
  playbookRef: { kind: 'AnsiblePlaybook', name: '' },
  inventoryRef: { kind: 'AnsibleInventory', name: '' },
  parallel: { enabled: false, maxAmountOfHosts: 1, maxConcurrentRuns: 10 },
});

async function submit() {
  let extraVars: Record<string, unknown> | undefined;
  try {
    extraVars = extraVarsText.value.trim() ? YAML.parse(extraVarsText.value) : undefined;
  } catch (err) {
    ElMessage.error(`Extra vars must be valid YAML: ${(err as Error).message}`);
    return;
  }

  const namespace = namespaceStore.current;
  try {
    const run = await store.create(
      {
        apiVersion: API_GROUP_VERSION,
        kind: 'AnsibleRun',
        metadata: { generateName: `${form.playbookRef.name || 'run'}-`, namespace },
        spec: { ...form, extraVars },
      },
      namespace,
    );
    ElMessage.success('Run started');
    router.push(`/runs/${run.metadata.namespace}/${run.metadata.name}`);
  } catch (err) {
    ElMessage.error((err as Error).message);
  }
}
</script>

<template>
  <div>
    <h2>New Run</h2>
    <el-form label-width="160px">
      <ObjectRefPicker
        v-model="form.playbookRef"
        label="Playbook"
        namespaced-kind="AnsiblePlaybook"
        cluster-kind="ClusterAnsiblePlaybook"
        :namespace="namespaceStore.current"
      />
      <ObjectRefPicker
        v-model="form.inventoryRef"
        label="Inventory"
        namespaced-kind="AnsibleInventory"
        cluster-kind="ClusterAnsibleInventory"
        :namespace="namespaceStore.current"
      />
      <el-form-item label="Extra vars (YAML)">
        <el-input v-model="extraVarsText" type="textarea" :rows="6" placeholder="key: value" />
      </el-form-item>

      <el-form-item label="Run in parallel">
        <el-switch v-model="form.parallel!.enabled" />
      </el-form-item>
      <template v-if="form.parallel?.enabled">
        <el-form-item label="Hosts per pod">
          <el-input-number v-model="form.parallel!.maxAmountOfHosts" :min="1" />
        </el-form-item>
        <el-form-item label="Max concurrent pods">
          <el-input-number v-model="form.parallel!.maxConcurrentRuns" :min="1" />
        </el-form-item>
      </template>

      <el-form-item>
        <el-button type="primary" @click="submit">Launch</el-button>
      </el-form-item>
    </el-form>
  </div>
</template>
