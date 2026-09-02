<script setup lang="ts">
import type { VarsBySecretEntry } from '@a5e/schemas';

const props = defineProps<{
  modelValue: VarsBySecretEntry[] | undefined;
  /** True for a cluster-scoped ClusterAnsibleHost, where every entry MUST name a namespace (there
   * is no owning one to default to). A namespaced AnsibleHost may only ever use its own, so the
   * field is hidden entirely rather than offered and then rejected server-side. */
  namespaceRequired: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [VarsBySecretEntry[] | undefined] }>();

function update(entries: VarsBySecretEntry[]) {
  emit('update:modelValue', entries.length ? entries : undefined);
}

function addEntry() {
  update([...(props.modelValue ?? []), { name: '' }]);
}

function removeEntry(index: number) {
  update((props.modelValue ?? []).filter((_, i) => i !== index));
}

function patchEntry(index: number, patch: Partial<VarsBySecretEntry>) {
  update((props.modelValue ?? []).map((e, i) => (i === index ? { ...e, ...patch } : e)));
}
</script>

<template>
  <div style="width: 100%">
    <div v-for="(entry, index) in modelValue ?? []" :key="index" style="display: flex; gap: 8px; margin-bottom: 8px">
      <el-input
        :model-value="entry.name"
        placeholder="Secret name"
        @update:model-value="(v: string | number) => patchEntry(index, { name: String(v) })"
      />
      <el-input
        v-if="namespaceRequired"
        :model-value="entry.namespace"
        placeholder="Secret namespace (required)"
        style="width: 240px"
        @update:model-value="(v: string | number) => patchEntry(index, { namespace: String(v) })"
      />
      <el-button size="small" @click="removeEntry(index)">Remove</el-button>
    </div>
    <el-button size="small" @click="addEntry">+ Add secret</el-button>
    <div style="color: var(--el-text-color-secondary); font-size: 12px; margin-top: 6px">
      Every key in each Secret becomes a host var of the same name. Values are never shown back —
      the resolved-inventory download masks them. Later entries override earlier ones, and a
      matching key in Vars below overrides them all. Requires the <code>use</code> permission on
      <code>Secret</code>{{ namespaceRequired ? '' : ' in this host’s namespace' }}.
    </div>
  </div>
</template>
