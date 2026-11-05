<script setup lang="ts">
import type { VarsFrom } from '@a5e/schemas';

type RefKind = 'secretRef' | 'configMapRef';

const props = defineProps<{
  modelValue: VarsFrom[] | undefined;
  /** True for a cluster-scoped ClusterAnsibleHost, where every entry MUST name a namespace (there
   * is no owning one to default to). A namespaced AnsibleHost may only ever use its own, so the
   * field is hidden entirely rather than offered and then rejected server-side. */
  namespaceRequired: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [VarsFrom[] | undefined] }>();

/** Exactly one of the two is set on every entry — CEL-enforced by the CRD (hosts.ts). */
function kindOf(entry: VarsFrom): RefKind {
  return entry.configMapRef ? 'configMapRef' : 'secretRef';
}

function update(entries: VarsFrom[]) {
  emit('update:modelValue', entries.length ? entries : undefined);
}

function addEntry() {
  update([...(props.modelValue ?? []), { secretRef: { name: '' } }]);
}

function removeEntry(index: number) {
  update((props.modelValue ?? []).filter((_, i) => i !== index));
}

/** Replaces the whole entry, so switching kind can never leave both refs set. */
function setKind(index: number, kind: RefKind) {
  update(
    (props.modelValue ?? []).map((e, i) =>
      i === index ? { [kind]: e.secretRef ?? e.configMapRef ?? { name: '' } } : e,
    ),
  );
}

function patchRef(index: number, patch: { name?: string; namespace?: string }) {
  update(
    (props.modelValue ?? []).map((e, i) => {
      if (i !== index) return e;
      const kind = kindOf(e);
      return { [kind]: { ...(e[kind] ?? { name: '' }), ...patch } };
    }),
  );
}
</script>

<template>
  <div style="width: 100%">
    <div v-for="(entry, index) in modelValue ?? []" :key="index" style="display: flex; gap: 8px; margin-bottom: 8px">
      <el-select
        :model-value="kindOf(entry)"
        style="width: 150px"
        @update:model-value="(v: RefKind) => setKind(index, v)"
      >
        <el-option label="Secret" value="secretRef" />
        <el-option label="ConfigMap" value="configMapRef" />
      </el-select>
      <el-input
        :model-value="(entry.secretRef ?? entry.configMapRef)?.name"
        placeholder="name"
        @update:model-value="(v: string | number) => patchRef(index, { name: String(v) })"
      />
      <el-input
        v-if="namespaceRequired"
        :model-value="(entry.secretRef ?? entry.configMapRef)?.namespace"
        placeholder="namespace (required)"
        style="width: 240px"
        @update:model-value="(v: string | number) => patchRef(index, { namespace: String(v) })"
      />
      <el-button size="small" @click="removeEntry(index)">Remove</el-button>
    </div>
    <el-button size="small" @click="addEntry">+ Add source</el-button>
    <div style="color: var(--el-text-color-secondary); font-size: 12px; margin-top: 6px">
      Every key in each Secret or ConfigMap becomes a host var of the same name, like a container’s
      <code>envFrom</code>. Runs read the values from a mounted copy, so they never appear in the
      generated inventory. In the resolved-inventory download, Secret values over 5 characters are
      masked; ConfigMap values are shown as-is. Later entries override earlier ones, and a matching
      key in Vars below overrides them all. Requires the <code>use</code> permission on
      <code>Secret</code>/<code>ConfigMap</code>{{ namespaceRequired ? '' : ' in this host’s namespace' }}.
    </div>
  </div>
</template>
