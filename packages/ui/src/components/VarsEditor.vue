<script setup lang="ts">
import { ref, watch } from 'vue';
import YAML from 'yaml';

const props = defineProps<{ modelValue: Record<string, unknown> | undefined }>();
const emit = defineEmits<{ 'update:modelValue': [Record<string, unknown> | undefined] }>();

function toText(value: Record<string, unknown> | undefined): string {
  return value && Object.keys(value).length ? YAML.stringify(value) : '';
}

const text = ref(toText(props.modelValue));
const error = ref<string | null>(null);
// Set right before an emit caused by our own onInput, so the modelValue watcher below doesn't
// immediately overwrite `text` with a re-serialized (and possibly differently-formatted) version
// of what the user is still typing.
let suppressNextSync = false;

watch(
  () => props.modelValue,
  (value) => {
    if (suppressNextSync) {
      suppressNextSync = false;
      return;
    }
    text.value = toText(value);
    error.value = null;
  },
);

function onInput(value: string) {
  text.value = value;
  try {
    const parsed = value.trim() ? YAML.parse(value) : undefined;
    // Partial input while typing can parse as valid YAML that isn't an object — e.g. a bare
    // "probe" parses as the string "probe" before ": value" is typed. Only emit object-shaped
    // (or empty) results; report anything else as an error instead of silently propagating a
    // string/array up to the vars field.
    if (parsed !== undefined && (typeof parsed !== 'object' || Array.isArray(parsed))) {
      error.value = 'Vars must be a YAML mapping (key: value pairs)';
      return;
    }
    error.value = null;
    suppressNextSync = true;
    emit('update:modelValue', parsed);
  } catch (err) {
    error.value = (err as Error).message;
  }
}
</script>

<template>
  <div style="width: 100%">
    <el-input :model-value="text" type="textarea" :rows="4" placeholder="key: value" @update:model-value="onInput" />
    <div v-if="error" style="color: var(--el-color-danger); font-size: 12px; margin-top: 4px">{{ error }}</div>
  </div>
</template>
