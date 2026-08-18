<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RESOURCE_DESCRIPTORS_BY_KIND } from '@a5e/schemas';
import type { JumpHost } from '@a5e/schemas';
import { apiClient } from '../api/client';
import { resourceBasePath } from '../api/resource-path';

const props = defineProps<{
  modelValue: JumpHost | undefined;
  /** Namespace to list AnsibleHost options from (and the implicit namespace an AnsibleHost ref resolves to when parentScope is 'namespaced'). */
  namespace: string;
  /** Whether the object this jumpHost belongs to (the AnsibleHost/ClusterAnsibleHost being edited) is namespaced or cluster-scoped — a cluster-scoped parent has no owning namespace, so an AnsibleHost-kind ref needs an explicit one (same rule as inventory host sources). */
  parentScope: 'namespaced' | 'cluster';
}>();
const emit = defineEmits<{ 'update:modelValue': [JumpHost | undefined] }>();

const enabled = computed(() => props.modelValue !== undefined);
const mode = computed<'address' | 'hostRef'>(() => (props.modelValue?.hostRef ? 'hostRef' : 'address'));
const hostRefKind = computed(() => props.modelValue?.hostRef?.kind ?? 'AnsibleHost');
const namespaceRequired = computed(() => props.parentScope === 'cluster' && hostRefKind.value === 'AnsibleHost');
const effectiveNamespace = computed(() => props.modelValue?.hostRef?.namespace || props.namespace);

const options = ref<string[]>([]);
const loading = ref(false);

async function loadOptions() {
  loading.value = true;
  try {
    const descriptor = RESOURCE_DESCRIPTORS_BY_KIND[hostRefKind.value]!;
    const namespace = descriptor.scope === 'Namespaced' ? effectiveNamespace.value : undefined;
    if (descriptor.scope === 'Namespaced' && !namespace) {
      options.value = [];
      return;
    }
    const path = resourceBasePath(descriptor, namespace);
    const result = await apiClient.list<{ metadata: { name: string } }>(path);
    options.value = result.items.map((i) => i.metadata.name);
  } finally {
    loading.value = false;
  }
}
watch([hostRefKind, effectiveNamespace], loadOptions);
onMounted(() => {
  if (mode.value === 'hostRef') loadOptions();
});

function toggle(on: boolean) {
  emit('update:modelValue', on ? { address: '' } : undefined);
}
function setMode(next: 'address' | 'hostRef') {
  if (next === 'hostRef') loadOptions();
  emit('update:modelValue', next === 'address' ? { address: '' } : { hostRef: { kind: 'AnsibleHost', name: '' } });
}
function updateAddress(patch: Partial<{ address: string; user: string; port: number }>) {
  emit('update:modelValue', { address: '', ...props.modelValue, ...patch });
}
function updateHostRef(patch: Partial<{ kind: 'AnsibleHost' | 'ClusterAnsibleHost'; name: string; namespace: string }>) {
  emit('update:modelValue', { hostRef: { kind: 'AnsibleHost', name: '', ...props.modelValue?.hostRef, ...patch } });
}
function setHostRefKind(kind: 'AnsibleHost' | 'ClusterAnsibleHost') {
  updateHostRef({ kind, name: '', namespace: undefined });
}
</script>

<template>
  <div style="width: 100%">
    <el-switch :model-value="enabled" @update:model-value="toggle" />
    <template v-if="enabled">
      <el-radio-group :model-value="mode" style="margin: 8px 0" @update:model-value="setMode">
        <el-radio-button value="address">Address</el-radio-button>
        <el-radio-button value="hostRef">Existing host</el-radio-button>
      </el-radio-group>

      <div v-if="mode === 'address'" style="display: flex; gap: 8px">
        <el-input :model-value="modelValue?.address" placeholder="bastion.example.com" @update:model-value="(v: string | number) => updateAddress({ address: String(v) })" />
        <el-input :model-value="modelValue?.user" placeholder="user" style="width: 140px" @update:model-value="(v: string | number) => updateAddress({ user: String(v) })" />
        <el-input-number :model-value="modelValue?.port" placeholder="port" :min="1" :max="65535" @update:model-value="(v: number | undefined) => updateAddress({ port: v ?? undefined })" />
      </div>
      <div v-else style="display: flex; gap: 8px; align-items: center">
        <el-radio-group :model-value="hostRefKind" @update:model-value="(v: string | number) => setHostRefKind(v as 'AnsibleHost' | 'ClusterAnsibleHost')">
          <el-radio-button value="AnsibleHost">AnsibleHost</el-radio-button>
          <el-radio-button value="ClusterAnsibleHost">ClusterAnsibleHost</el-radio-button>
        </el-radio-group>
        <el-input
          v-if="namespaceRequired"
          :model-value="modelValue?.hostRef?.namespace"
          placeholder="namespace (required)"
          style="width: 180px"
          @update:model-value="(v: string | number) => updateHostRef({ namespace: String(v) })"
        />
        <el-select
          :model-value="modelValue?.hostRef?.name"
          filterable
          placeholder="Select..."
          :loading="loading"
          :disabled="namespaceRequired && !modelValue?.hostRef?.namespace"
          style="flex: 1"
          @update:model-value="(v: string) => updateHostRef({ name: v })"
        >
          <el-option v-for="name in options" :key="name" :label="name" :value="name" />
        </el-select>
      </div>
    </template>
  </div>
</template>
