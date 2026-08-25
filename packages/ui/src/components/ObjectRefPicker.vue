<script setup lang="ts">
import { RESOURCE_DESCRIPTORS_BY_KIND } from '@a5e/schemas';
import { computed, onMounted, ref, watch } from 'vue';
import { apiClient } from '../api/client';
import { resourceBasePath } from '../api/resource-path';
import { useChangeRequestDraftStore } from '../stores/changeRequestDraft';

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
const liveOptions = ref<string[]>([]);
const loading = ref(false);
const draftStore = useChangeRequestDraftStore();

// While a change-request draft is active, a staged-but-not-yet-created object of the referenced
// kind won't show up in the live list above — merge in its name so it's at least selectable
// (resolves once the request is approved and applied in order, since `changes` array order is
// apply order). Accepted v1 limitation: no validation beyond "the name exists in the draft."
const pendingCreateNames = computed(() => {
  const kind = isCluster.value ? props.clusterKind : props.namespacedKind;
  return draftStore.items
    .filter((i) => i.kind === 'create' && i.type === kind && i.name)
    .map((i) => i.name as string);
});
const options = computed(() => [...new Set([...liveOptions.value, ...pendingCreateNames.value])]);

async function loadOptions() {
  loading.value = true;
  try {
    const kind = isCluster.value ? props.clusterKind : props.namespacedKind;
    const descriptor = RESOURCE_DESCRIPTORS_BY_KIND[kind]!;
    if (namespaceRequired.value && !props.modelValue.namespace) {
      liveOptions.value = [];
      return;
    }
    const path = resourceBasePath(
      descriptor,
      descriptor.scope === 'Namespaced' ? effectiveNamespace.value : undefined,
    );
    const result = await apiClient.list<{ metadata: { name: string } }>(path);
    liveOptions.value = result.items.map((i) => i.metadata.name);
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
