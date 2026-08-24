<script setup lang="ts">
import { RESOURCE_DESCRIPTORS_BY_KIND } from '@a5e/schemas';
import { computed, onMounted, ref, watch } from 'vue';
import { apiClient } from '../api/client';
import { resourceBasePath } from '../api/resource-path';

const props = withDefaults(
  defineProps<{
    modelValue: { kind: string; name: string; namespace?: string };
    namespacedKind: string;
    clusterKind: string;
    namespace: string;
    label: string;
    /** Whether the object holding this ref is namespaced or cluster-scoped — a cluster-scoped parent has no owning namespace, so a namespaced-kind ref needs an explicit one. */
    parentScope?: 'namespaced' | 'cluster';
  }>(),
  { parentScope: 'namespaced' },
);
const emit = defineEmits<{
  'update:modelValue': [{ kind: string; name: string; namespace?: string }];
}>();

const isCluster = computed(() => props.modelValue.kind === props.clusterKind);
const namespaceRequired = computed(() => props.parentScope === 'cluster' && !isCluster.value);
const effectiveNamespace = computed(() => props.modelValue.namespace || props.namespace);
const options = ref<string[]>([]);
const loading = ref(false);

async function loadOptions() {
  loading.value = true;
  try {
    const kind = isCluster.value ? props.clusterKind : props.namespacedKind;
    const descriptor = RESOURCE_DESCRIPTORS_BY_KIND[kind]!;
    if (namespaceRequired.value && !props.modelValue.namespace) {
      options.value = [];
      return;
    }
    const path = resourceBasePath(
      descriptor,
      descriptor.scope === 'Namespaced' ? effectiveNamespace.value : undefined,
    );
    const result = await apiClient.list<{ metadata: { name: string } }>(path);
    options.value = result.items.map((i) => i.metadata.name);
  } finally {
    loading.value = false;
  }
}

watch([isCluster, effectiveNamespace], loadOptions);
onMounted(loadOptions);

function setScope(cluster: boolean) {
  emit('update:modelValue', { kind: cluster ? props.clusterKind : props.namespacedKind, name: '' });
}
function setName(name: string) {
  emit('update:modelValue', { ...props.modelValue, name });
}
function setNamespace(namespace: string) {
  emit('update:modelValue', { ...props.modelValue, namespace });
}
</script>

<template>
  <el-form-item :label="label">
    <div style="display: flex; gap: 8px; width: 100%">
      <el-radio-group :model-value="isCluster" @update:model-value="setScope">
        <el-radio-button :value="false">Namespace</el-radio-button>
        <el-radio-button :value="true">Cluster</el-radio-button>
      </el-radio-group>
      <el-input
        v-if="namespaceRequired"
        :model-value="modelValue.namespace"
        placeholder="namespace (required)"
        style="width: 180px"
        @update:model-value="(v: string | number) => setNamespace(String(v))"
      />
      <el-select
        :model-value="modelValue.name"
        filterable
        placeholder="Select..."
        style="flex: 1"
        :loading="loading"
        :disabled="namespaceRequired && !modelValue.namespace"
        @update:model-value="setName"
      >
        <el-option v-for="name in options" :key="name" :label="name" :value="name" />
      </el-select>
    </div>
  </el-form-item>
</template>
