<script setup lang="ts">
import type { CustomResource } from '@a5e/schemas';
import { Search } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useChangeRequestDraftStore } from '../stores/changeRequestDraft';

const props = defineProps<{
  title: string;
  store: {
    items: Map<string, CustomResource<unknown, unknown>>;
    loading: boolean;
    error: string | null;
    list: (namespace?: string) => Promise<void>;
    remove: (name: string, namespace?: string, previous?: unknown) => Promise<void>;
    stop: () => void;
  };
  namespaced: boolean;
  namespace?: string;
  createPath: string;
  editPath: (item: CustomResource<unknown, unknown>) => string;
  /** The CRD kind this list shows — used to cross-reference rows against an active change-request
   * draft's staged items, so a row with a pending change shows a badge instead of silently still
   * being there after a staged (not yet applied) delete. */
  resourceType: string;
  /** Extra per-page predicate ANDed with search/labels — e.g. HostListView's "Enabled" filter. */
  extraFilter?: (item: CustomResource<unknown, unknown>) => boolean;
}>();

const router = useRouter();
const draftStore = useChangeRequestDraftStore();

function pendingFor(item: CustomResource<unknown, unknown>): 'update' | 'delete' | undefined {
  const match = draftStore.items.find(
    (i) =>
      i.type === props.resourceType &&
      i.name === item.metadata.name &&
      i.namespace === item.metadata.namespace &&
      i.kind !== 'create',
  );
  return match?.kind === 'delete' ? 'delete' : match ? 'update' : undefined;
}

const search = ref('');
const labelFilterText = ref('');

/** "role=web,tier=prod" -> [["role","web"],["tier","prod"]]; a bare "role" (no "=") matches any value, just requires the key to be present — mirrors kubectl's label-selector shorthand for existence checks. */
function parseLabelFilter(text: string): Array<[string, string | null]> {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf('=');
      return eq === -1 ? [part, null] : [part.slice(0, eq).trim(), part.slice(eq + 1).trim()];
    });
}

function matchesLabelFilter(
  item: CustomResource<unknown, unknown>,
  pairs: Array<[string, string | null]>,
): boolean {
  if (pairs.length === 0) return true;
  const labels = item.metadata.labels ?? {};
  return pairs.every(([key, value]) => (value === null ? key in labels : labels[key] === value));
}

const rows = computed(() => {
  const labelPairs = parseLabelFilter(labelFilterText.value);
  const searchTerm = search.value.trim().toLowerCase();
  return Array.from(props.store.items.values())
    .filter((item) => !searchTerm || item.metadata.name.toLowerCase().includes(searchTerm))
    .filter((item) => matchesLabelFilter(item, labelPairs))
    .filter((item) => !props.extraFilter || props.extraFilter(item))
    .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
});

function readyStatus(item: CustomResource<unknown, unknown>): {
  text: string;
  type: 'success' | 'danger' | 'info';
} {
  const status = item.status as
    | { conditions?: Array<{ type: string; status: string; reason: string }> }
    | undefined;
  const ready = status?.conditions?.find((c) => c.type === 'Ready');
  if (!ready) return { text: 'Unknown', type: 'info' };
  return ready.status === 'True'
    ? { text: 'Ready', type: 'success' }
    : { text: ready.reason, type: 'danger' };
}

async function reload() {
  await props.store.list(props.namespaced ? props.namespace : undefined);
}

async function onDelete(item: CustomResource<unknown, unknown>) {
  try {
    await ElMessageBox.confirm(`Delete ${item.metadata.name}?`, 'Confirm', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await props.store.remove(item.metadata.name, item.metadata.namespace, item);
    ElMessage.success(draftStore.isActive ? 'Added to change request draft' : 'Deleted');
  } catch (err) {
    ElMessage.error((err as Error).message);
  }
}

onMounted(reload);
onUnmounted(() => props.store.stop());
watch(
  () => props.namespace,
  () => {
    if (props.namespaced) reload();
  },
);

defineExpose({ reload });
</script>

<template>
  <div>
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px">
      <h2 style="margin: 0">{{ title }}</h2>
      <el-button type="primary" @click="router.push(createPath)">New</el-button>
    </div>

    <el-alert v-if="store.error" :title="store.error" type="error" style="margin-bottom: 12px" />

    <div style="display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap">
      <el-input v-model="search" placeholder="Search by name" clearable style="max-width: 240px">
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <el-input v-model="labelFilterText" placeholder="Labels, e.g. role=web,tier=prod" clearable style="max-width: 280px" />
      <slot name="filters" />
    </div>

    <el-table
      v-loading="store.loading"
      :data="rows"
      style="width: 100%"
      @row-click="(row: CustomResource<unknown, unknown>) => router.push(editPath(row))"
    >
      <el-table-column prop="metadata.name" label="Name" />
      <el-table-column v-if="namespaced" prop="metadata.namespace" label="Namespace" width="140" />
      <slot name="columns" />
      <el-table-column label="Status" width="140">
        <template #default="{ row }">
          <el-tag v-if="pendingFor(row)" type="warning">Pending {{ pendingFor(row) }}</el-tag>
          <el-tag v-else :type="readyStatus(row).type">{{ readyStatus(row).text }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="Age" width="160">
        <template #default="{ row }">{{ new Date(row.metadata.creationTimestamp).toLocaleString() }}</template>
      </el-table-column>
      <el-table-column label="Actions" width="100">
        <template #default="{ row }">
          <el-button
            size="small"
            type="danger"
            :disabled="Boolean(pendingFor(row))"
            @click.stop="onDelete(row)"
          >
            Delete
          </el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
:deep(.el-table__row) {
  cursor: pointer;
}
</style>
