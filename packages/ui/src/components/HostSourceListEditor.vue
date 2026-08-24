<script setup lang="ts">
import type { InventoryGroup } from '@a5e/schemas';
import LabelSelectorEditor from './LabelSelectorEditor.vue';
import VarsEditor from './VarsEditor.vue';

const props = defineProps<{
  modelValue: InventoryGroup[];
  /** True for a namespaced AnsibleInventory, false for a ClusterAnsibleInventory (plan §2.6's
   * namespace table: an `AnsibleHost` source only ever takes an explicit namespace when the
   * *parent* inventory is cluster-scoped; a `ClusterAnsibleHost` source never takes one at all). */
  namespaced: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [InventoryGroup[]] }>();

function update(groups: InventoryGroup[]) {
  emit('update:modelValue', groups);
}

function addGroup() {
  update([...props.modelValue, { name: '', hostSources: [] }]);
}
function removeGroup(gi: number) {
  const groups = [...props.modelValue];
  groups.splice(gi, 1);
  update(groups);
}
function updateGroupName(gi: number, name: string) {
  const groups = [...props.modelValue];
  groups[gi] = { ...groups[gi]!, name };
  update(groups);
}

function addHostSource(gi: number) {
  const groups = [...props.modelValue];
  const group = groups[gi]!;
  groups[gi] = {
    ...group,
    hostSources: [...group.hostSources, { kind: 'AnsibleHost', labelSelector: {} }],
  };
  update(groups);
}
function removeHostSource(gi: number, hi: number) {
  const groups = [...props.modelValue];
  const group = groups[gi]!;
  const hostSources = [...group.hostSources];
  hostSources.splice(hi, 1);
  groups[gi] = { ...group, hostSources };
  update(groups);
}
function updateHostSourceKind(gi: number, hi: number, kind: 'AnsibleHost' | 'ClusterAnsibleHost') {
  const groups = [...props.modelValue];
  const group = groups[gi]!;
  const hostSources = [...group.hostSources];
  const namespaceApplies = kind === 'AnsibleHost' && !props.namespaced;
  hostSources[hi] = {
    ...hostSources[hi]!,
    kind,
    namespace: namespaceApplies ? hostSources[hi]!.namespace : undefined,
  };
  groups[gi] = { ...group, hostSources };
  update(groups);
}
function updateHostSourceNamespace(gi: number, hi: number, namespace: string) {
  const groups = [...props.modelValue];
  const group = groups[gi]!;
  const hostSources = [...group.hostSources];
  hostSources[hi] = { ...hostSources[hi]!, namespace };
  groups[gi] = { ...group, hostSources };
  update(groups);
}
function updateLabelSelector(
  gi: number,
  hi: number,
  labelSelector: InventoryGroup['hostSources'][number]['labelSelector'],
) {
  const groups = [...props.modelValue];
  const group = groups[gi]!;
  const hostSources = [...group.hostSources];
  hostSources[hi] = { ...hostSources[hi]!, labelSelector };
  groups[gi] = { ...group, hostSources };
  update(groups);
}
function updateGroupVars(gi: number, vars: InventoryGroup['vars']) {
  const groups = [...props.modelValue];
  groups[gi] = { ...groups[gi]!, vars };
  update(groups);
}
</script>

<template>
  <div style="width: 100%">
    <el-card v-for="(group, gi) in modelValue" :key="gi" style="width: 100%; margin-bottom: 16px">
      <template #header>
        <div style="display: flex; gap: 8px; align-items: center">
          <el-input :model-value="group.name" placeholder="group name" @update:model-value="(v: string | number) => updateGroupName(gi, String(v))" />
          <el-button type="danger" size="small" @click="removeGroup(gi)">Remove group</el-button>
        </div>
      </template>

      <div v-for="(source, hi) in group.hostSources" :key="hi" style="border: 1px solid var(--el-border-color); padding: 12px; margin-bottom: 8px; border-radius: 4px">
        <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 8px">
          <el-radio-group :model-value="source.kind" @update:model-value="(v: string | number) => updateHostSourceKind(gi, hi, v as 'AnsibleHost' | 'ClusterAnsibleHost')">
            <el-radio-button value="AnsibleHost">AnsibleHost</el-radio-button>
            <el-radio-button value="ClusterAnsibleHost">ClusterAnsibleHost</el-radio-button>
          </el-radio-group>
          <el-input
            v-if="source.kind === 'AnsibleHost' && !namespaced"
            :model-value="source.namespace"
            placeholder="host namespace (required)"
            style="width: 220px"
            @update:model-value="(v: string | number) => updateHostSourceNamespace(gi, hi, String(v))"
          />
          <el-button size="small" @click="removeHostSource(gi, hi)">Remove</el-button>
        </div>
        <LabelSelectorEditor :model-value="source.labelSelector" @update:model-value="(v) => updateLabelSelector(gi, hi, v)" />
      </div>
      <el-button size="small" @click="addHostSource(gi)">+ Add host source</el-button>

      <div style="margin-top: 12px">
        <div style="margin-bottom: 4px; color: var(--el-text-color-secondary); font-size: 13px">Group vars (YAML)</div>
        <VarsEditor :model-value="group.vars" @update:model-value="(v) => updateGroupVars(gi, v)" />
      </div>
    </el-card>

    <el-button @click="addGroup">+ Add group</el-button>
  </div>
</template>
