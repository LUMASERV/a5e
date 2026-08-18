<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ modelValue: Record<string, string> | undefined }>();
const emit = defineEmits<{ 'update:modelValue': [Record<string, string> | undefined] }>();

const entries = computed(() => Object.entries(props.modelValue ?? {}));

function update(next: Array<[string, string]>) {
  emit('update:modelValue', next.length ? Object.fromEntries(next) : undefined);
}
function addLabel() {
  update([...entries.value, ['', '']]);
}
function updateKey(index: number, key: string) {
  const next = [...entries.value];
  next[index] = [key, next[index]?.[1] ?? ''];
  update(next);
}
function updateValue(index: number, value: string) {
  const next = [...entries.value];
  next[index] = [next[index]?.[0] ?? '', value];
  update(next);
}
function remove(index: number) {
  const next = [...entries.value];
  next.splice(index, 1);
  update(next);
}
</script>

<template>
  <div style="width: 100%">
    <div v-for="(entry, i) in entries" :key="i" style="display: flex; gap: 8px; margin-bottom: 8px">
      <el-input :model-value="entry[0]" placeholder="key" @update:model-value="(v: string | number) => updateKey(i, String(v))" />
      <el-input :model-value="entry[1]" placeholder="value" @update:model-value="(v: string | number) => updateValue(i, String(v))" />
      <el-button @click="remove(i)">Remove</el-button>
    </div>
    <el-button size="small" @click="addLabel">+ Add label</el-button>
  </div>
</template>
