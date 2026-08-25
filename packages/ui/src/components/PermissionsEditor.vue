<script setup lang="ts">
import { PERMISSION_ACTIONS, PERMISSION_TYPES, RESOURCE_DESCRIPTORS_BY_KIND } from '@a5e/schemas';
import type { Permission } from '@a5e/schemas';
import { onMounted } from 'vue';
import { useNamespaceStore } from '../stores/namespace';
import LabelSelectorEditor from './LabelSelectorEditor.vue';

const props = defineProps<{ modelValue: Permission[]; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [Permission[]] }>();

const namespaceStore = useNamespaceStore();
onMounted(() => namespaceStore.load());

// Every kind supports the plain CRUD verbs; a handful of kinds additionally expose one or two
// domain-specific actions (see auth/permission-engine.ts's canAct call sites) — no kind supports
// all of PERMISSION_ACTIONS, so showing the full list regardless of the selected Type let an admin
// grant e.g. "download" on an AnsibleHost, which the API would just never check. 'propose' is
// reserved/unenforced (any logged-in user can already propose a change request) and omitted
// entirely so granting it doesn't imply it does something yet.
const UNIVERSAL_ACTIONS = ['list', 'get', 'watch', 'create', 'update', 'delete'] as const;
const TYPE_SPECIFIC_ACTIONS: Record<string, readonly string[]> = {
  AnsibleJob: ['trigger'],
  AnsibleRun: ['cancel', 'retry'],
  AnsibleInventory: ['download'],
  ClusterAnsibleInventory: ['download'],
  AnsibleSSHKey: ['import'],
  ClusterAnsibleSSHKey: ['import'],
  ChangeRequest: ['approve'],
};
const ALL_REAL_ACTIONS = PERMISSION_ACTIONS.filter((a) => a !== 'propose');

function actionOptionsFor(type: string): readonly string[] {
  // A wildcard type could resolve to any kind at check time, so every real action stays selectable.
  if (type === '*') return ALL_REAL_ACTIONS;
  return [...UNIVERSAL_ACTIONS, ...(TYPE_SPECIFIC_ACTIONS[type] ?? [])];
}

function isClusterScoped(type: string): boolean {
  return RESOURCE_DESCRIPTORS_BY_KIND[type]?.scope === 'Cluster';
}

function summary(p: Permission): string {
  const type = p.type === '*' ? 'All types' : p.type;
  const ns = isClusterScoped(p.type)
    ? ''
    : ` · ${p.namespaces.length === 0 ? 'all namespaces' : `${p.namespaces.length} namespace${p.namespaces.length === 1 ? '' : 's'}`}`;
  const actions = p.actions.includes('*') ? 'all actions' : p.actions.join(', ');
  return `${type}${ns} · ${actions}`;
}

function update(index: number, patch: Partial<Permission>) {
  const next = props.modelValue.map((p, i) => (i === index ? { ...p, ...patch } : p));
  emit('update:modelValue', next);
}

function setType(index: number, type: string) {
  const current = props.modelValue[index]!;
  const allowed = actionOptionsFor(type);
  update(index, {
    type: type as Permission['type'],
    namespaces: isClusterScoped(type) ? [] : current.namespaces,
    // Drop any action that doesn't apply to the new type (e.g. switching off AnsibleInventory
    // should drop a stray 'download') — '*' ("all actions") always stays valid regardless of type.
    actions: current.actions.includes('*')
      ? current.actions
      : current.actions.filter((a) => (allowed as string[]).includes(a)),
  });
}

function setAllActions(index: number, all: boolean) {
  update(index, { actions: all ? ['*'] : [] });
}

function addPermission() {
  const first = PERMISSION_TYPES[0] ?? '*';
  emit('update:modelValue', [...props.modelValue, { type: first, namespaces: [], actions: [] }]);
}

function removePermission(index: number) {
  emit(
    'update:modelValue',
    props.modelValue.filter((_, i) => i !== index),
  );
}
</script>

<template>
  <div>
    <el-collapse v-if="modelValue.length">
      <el-collapse-item v-for="(perm, index) in modelValue" :key="index">
        <template #title>
          <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; padding-right: 8px">
            <span>{{ summary(perm) }}</span>
            <el-button size="small" type="danger" :disabled="disabled" @click.stop="removePermission(index)">Remove</el-button>
          </div>
        </template>

        <el-form label-width="120px">
          <el-form-item label="Type">
            <el-select :model-value="perm.type" :disabled="disabled" style="width: 100%" @update:model-value="(v: string) => setType(index, v)">
              <el-option label="All types (*)" value="*" />
              <el-option v-for="t in PERMISSION_TYPES" :key="t" :label="t" :value="t" />
            </el-select>
          </el-form-item>

          <el-form-item label="Namespaces">
            <el-select
              v-if="!isClusterScoped(perm.type)"
              :model-value="perm.namespaces"
              multiple
              filterable
              allow-create
              default-first-option
              :disabled="disabled"
              style="width: 100%"
              placeholder="Leave empty for all namespaces"
              @update:model-value="(v: string[]) => update(index, { namespaces: v })"
            >
              <el-option v-for="ns in namespaceStore.namespaces" :key="ns" :label="ns" :value="ns" />
            </el-select>
            <span v-else style="color: var(--el-text-color-secondary)">Not applicable — cluster-scoped kind</span>
          </el-form-item>

          <el-form-item label="Labels">
            <LabelSelectorEditor
              :model-value="perm.labelSelector ?? {}"
              :disabled="disabled"
              @update:model-value="(v) => update(index, { labelSelector: Object.keys(v.matchLabels ?? {}).length ? v : undefined })"
            />
          </el-form-item>

          <el-form-item label="Actions">
            <el-checkbox
              :model-value="perm.actions.includes('*')"
              :disabled="disabled"
              @update:model-value="(v: boolean) => setAllActions(index, v)"
            >
              All actions
            </el-checkbox>
            <el-select
              v-if="!perm.actions.includes('*')"
              :model-value="perm.actions"
              multiple
              :disabled="disabled"
              style="width: 100%; margin-top: 8px"
              @update:model-value="(v: Permission['actions']) => update(index, { actions: v })"
            >
              <el-option v-for="a in actionOptionsFor(perm.type)" :key="a" :label="a" :value="a" />
            </el-select>
          </el-form-item>
        </el-form>
      </el-collapse-item>
    </el-collapse>
    <el-button size="small" :disabled="disabled" style="margin-top: 12px" @click="addPermission">+ Add permission</el-button>
  </div>
</template>
