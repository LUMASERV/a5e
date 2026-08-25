<script setup lang="ts">
import type { LabelSelector } from '@a5e/schemas';
import { computed } from 'vue';

const props = defineProps<{ modelValue: LabelSelector; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [LabelSelector] }>();

const matchLabelEntries = computed(() => Object.entries(props.modelValue.matchLabels ?? {}));

function updateMatchLabels(entries: Array<[string, string]>) {
  // Don't filter out blank-key rows here — the user is mid-edit right after clicking "+ Add
  // label" (key is '' until they type one); filtering eagerly deleted the row before they could
  // type anything. Blank keys are harmless to carry in local state; strip them at submit time
  // instead if it matters there.
  emit('update:modelValue', {
    ...props.modelValue,
    matchLabels: Object.fromEntries(entries),
  });
}

function addLabel() {
  updateMatchLabels([...matchLabelEntries.value, ['', '']]);
}
function updateLabelKey(index: number, key: string) {
  const entries = [...matchLabelEntries.value];
  entries[index] = [key, entries[index]?.[1] ?? ''];
  updateMatchLabels(entries);
}
function updateLabelValue(index: number, value: string) {
  const entries = [...matchLabelEntries.value];
  entries[index] = [entries[index]?.[0] ?? '', value];
  updateMatchLabels(entries);
}
function removeLabel(index: number) {
  const entries = [...matchLabelEntries.value];
  entries.splice(index, 1);
  updateMatchLabels(entries);
}
</script>

<template>
  <div style="width: 100%">
    <div v-for="(entry, i) in matchLabelEntries" :key="i" style="display: flex; gap: 8px; margin-bottom: 8px">
      <el-input :model-value="entry[0]" placeholder="key" :disabled="disabled" @update:model-value="(v: string | number) => updateLabelKey(i, String(v))" />
      <el-input :model-value="entry[1]" placeholder="value" :disabled="disabled" @update:model-value="(v: string | number) => updateLabelValue(i, String(v))" />
      <el-button :disabled="disabled" @click="removeLabel(i)">Remove</el-button>
    </div>
    <el-button size="small" :disabled="disabled" @click="addLabel">+ Add label</el-button>
  </div>
</template>
