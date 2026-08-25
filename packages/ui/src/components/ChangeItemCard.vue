<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    item: {
      action: 'create' | 'update' | 'delete';
      type: string;
      namespace?: string;
      name?: string;
      body?: unknown;
    };
    /** The object as it existed before this item — only meaningful for update/delete, and only
     * ever available client-side at staging time (the proposer already fetched it); a reviewer
     * looking at an already-submitted request has no such snapshot. */
    previousBody?: unknown;
    /** Show a "Remove from draft" button — only true on the proposer's own draft review page. */
    removable?: boolean;
  }>(),
  { removable: false },
);
const emit = defineEmits<{ remove: [] }>();

const actionType = computed(() =>
  props.item.action === 'create'
    ? 'success'
    : props.item.action === 'delete'
      ? 'danger'
      : 'warning',
);

function pretty(value: unknown): string {
  return value === undefined ? '—' : JSON.stringify(value, null, 2);
}
</script>

<template>
  <el-card style="margin-bottom: 12px">
    <template #header>
      <div style="display: flex; justify-content: space-between; align-items: center">
        <div style="display: flex; gap: 8px; align-items: center">
          <el-tag :type="actionType" size="small">{{ item.action }}</el-tag>
          <strong>{{ item.type }}</strong>
          <span v-if="item.namespace" style="color: var(--el-text-color-secondary)">{{ item.namespace }}/</span>
          <span>{{ item.name ?? '(name to be assigned)' }}</span>
        </div>
        <el-button v-if="removable" size="small" type="danger" @click="emit('remove')">Remove</el-button>
      </div>
    </template>

    <template v-if="item.action === 'update' && previousBody !== undefined">
      <div style="display: flex; gap: 12px">
        <div style="flex: 1">
          <div style="font-weight: 600; margin-bottom: 4px">Before</div>
          <el-input type="textarea" :rows="10" readonly :model-value="pretty(previousBody)" />
        </div>
        <div style="flex: 1">
          <div style="font-weight: 600; margin-bottom: 4px">After</div>
          <el-input type="textarea" :rows="10" readonly :model-value="pretty(item.body)" />
        </div>
      </div>
    </template>
    <template v-else-if="item.action === 'delete'">
      <div style="font-weight: 600; margin-bottom: 4px">Current (will be deleted)</div>
      <el-input type="textarea" :rows="10" readonly :model-value="pretty(previousBody ?? item.body)" />
    </template>
    <template v-else>
      <div style="font-weight: 600; margin-bottom: 4px">Proposed</div>
      <el-input type="textarea" :rows="10" readonly :model-value="pretty(item.body)" />
    </template>
  </el-card>
</template>
