<script setup lang="ts">
import { RESOURCE_DESCRIPTORS_BY_KIND } from '@a5e/schemas';
import type {
  AnsibleRunSpec,
  AnsibleRunStatus,
  CustomResource,
  RunShardStatus,
} from '@a5e/schemas';
import { AnsiUp } from 'ansi_up';
import { ElMessage } from 'element-plus';
import { nextTick, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { apiClient, downloadFile } from '../../api/client';
import { resourceBasePath } from '../../api/resource-path';
import { watchLogs, watchResource } from '../../api/watch';
import { useRunStore } from '../../stores/resources';

const props = defineProps<{ namespace: string; name: string }>();
const router = useRouter();
const store = useRunStore();
const item = ref<CustomResource<AnsibleRunSpec, AnsibleRunStatus> | null>(null);
let stopWatch: (() => void) | null = null;

// `undefined` means "no one shard picked": for a non-parallel run that's simply its one pod's
// top-level logs; for a `parallel` run the API aggregates every shard's log into one stream for
// it (see ansibleruns.ts's `/logs` route) — so `undefined` doubles as the "All shards" selection,
// and is the default rather than something the UI needs to resolve to a concrete index.
const selectedShard = ref<number | undefined>(undefined);
const logLines = ref<string[]>([]);
const logError = ref<string | null>(null);
const logContainer = ref<HTMLElement | null>(null);
let stopLogs: (() => void) | null = null;
// One instance for the whole stream (not per-line): ansi_up tracks open styles (e.g. bold
// started but not yet reset) across calls, so state carries correctly from line to line. It
// also HTML-escapes everything that isn't a recognized ANSI sequence, so the v-html below is
// safe against log content that happens to contain `<`/`&`/etc.
const ansiUp = new AnsiUp();

function phaseType(phase?: string): 'success' | 'danger' | 'warning' | 'info' {
  if (phase === 'Succeeded') return 'success';
  if (phase === 'Failed' || phase === 'Error') return 'danger';
  if (phase === 'Running' || phase === 'Resolving') return 'warning';
  return 'info';
}
const isTerminal = (phase?: string) =>
  ['Succeeded', 'Failed', 'Error', 'Cancelled'].includes(phase ?? '');
function shardRowClassName({ row }: { row: RunShardStatus }): string {
  return row.index === selectedShard.value ? 'is-selected-shard' : '';
}

const EDIT_ROUTE: Record<string, (name: string, namespace: string) => string> = {
  AnsiblePlaybook: (name, ns) => `/playbooks/${ns}/${name}/edit`,
  ClusterAnsiblePlaybook: (name) => `/cluster-playbooks/${name}/edit`,
  AnsibleInventory: (name, ns) => `/inventories/${ns}/${name}/edit`,
  ClusterAnsibleInventory: (name) => `/cluster-inventories/${name}/edit`,
};

function refRoute(
  ref: { kind: string; name: string; namespace?: string },
  ownNamespace: string,
): string {
  const descriptor = RESOURCE_DESCRIPTORS_BY_KIND[ref.kind];
  const namespace = ref.namespace ?? (descriptor?.scope === 'Namespaced' ? ownNamespace : '');
  return EDIT_ROUTE[ref.kind]?.(ref.name, namespace) ?? '/';
}

// Retry navigates via router.push to /runs/:namespace/:name with the same route, so Vue Router
// reuses this component instance instead of remounting it — a plain onMounted would never
// re-fire for the new run, leaving the page stuck showing the old one. Watching the route props
// (with immediate: true covering the initial mount) re-runs this for every navigation, not just
// the first.
watch(
  [() => props.name, () => props.namespace],
  async ([name, namespace]) => {
    stopWatch?.();
    // `undefined` ("All shards") is the default, not just the pre-load placeholder — a
    // `parallel` run's `/logs` (no `?shard`) aggregates every shard's log into one stream, so
    // there's a real all-shards view to land on rather than needing to guess shard 0.
    selectedShard.value = undefined;
    item.value = await store.get(name, namespace);
    const path = `${resourceBasePath(RESOURCE_DESCRIPTORS_BY_KIND.AnsibleRun!, namespace)}/watch`;
    stopWatch = watchResource(path, (type, obj) => {
      const run = obj as CustomResource<AnsibleRunSpec, AnsibleRunStatus>;
      if (run.metadata.name === name) item.value = run;
    });
  },
  { immediate: true },
);

// Separate from the resource watch above: restarts the log stream whenever the run changes, the
// selected shard changes, OR the run's phase changes — without re-fetching `item`/re-subscribing
// the resource watch. The phase dependency matters because the `/logs` SSE request is a one-shot
// snapshot of "what has logs right now": opening it while the run is still `Pending`/`Resolving`
// (no Job/shards yet) gets one "no logs available" event and then sits open forever, since the
// server has nothing that would make it push more. Reconnecting on every phase transition
// guarantees at least one connection is made after the Job/shards actually exist — cheap, since a
// run only passes through a handful of phases in its lifetime.
watch(
  [() => props.name, () => props.namespace, selectedShard, () => item.value?.status?.phase],
  ([name, namespace, shard]) => {
    stopLogs?.();
    logLines.value = [];
    logError.value = null;
    const shardQuery = shard !== undefined ? `?shard=${shard}` : '';
    stopLogs = watchLogs(
      `/namespaces/${namespace}/ansibleruns/${name}/logs${shardQuery}`,
      (line) => {
        logLines.value.push(ansiUp.ansi_to_html(line));
        nextTick(() => {
          logContainer.value?.scrollTo({ top: logContainer.value.scrollHeight });
        });
      },
      (message) => {
        logError.value = message;
      },
    );
  },
  { immediate: true },
);
onUnmounted(() => {
  stopWatch?.();
  stopLogs?.();
});

async function cancel() {
  await apiClient.post(`/namespaces/${props.namespace}/ansibleruns/${props.name}/cancel`);
  ElMessage.success('Cancel requested');
}
async function retry() {
  const created = await apiClient.post<CustomResource<AnsibleRunSpec, AnsibleRunStatus>>(
    `/namespaces/${props.namespace}/ansibleruns/${props.name}/retry`,
  );
  ElMessage.success('New run started');
  router.push(`/runs/${created.metadata.namespace}/${created.metadata.name}`);
}
async function downloadLogs() {
  const shard = selectedShard.value;
  const shardQuery = shard !== undefined ? `?shard=${shard}` : '';
  const suffix = shard !== undefined ? `-shard-${shard}` : '';
  try {
    await downloadFile(
      `/namespaces/${props.namespace}/ansibleruns/${props.name}/logs/download${shardQuery}`,
      `${props.name}${suffix}.log`,
    );
  } catch (err) {
    ElMessage.error((err as Error).message);
  }
}
</script>

<template>
  <div v-if="item">
    <h2>{{ item.metadata.name }}</h2>
    <el-descriptions :column="2" border style="margin-bottom: 16px">
      <el-descriptions-item label="Phase">
        <el-tag :type="phaseType(item.status?.phase)">{{ item.status?.phase ?? 'Pending' }}</el-tag>
      </el-descriptions-item>
      <el-descriptions-item label="Exit code">{{ item.status?.exitCode ?? '—' }}</el-descriptions-item>
      <el-descriptions-item label="Playbook">
        <el-button link type="primary" @click="router.push(refRoute(item.spec.playbookRef, namespace))">
          {{ item.spec.playbookRef.kind }}/{{ item.spec.playbookRef.name }}
        </el-button>
      </el-descriptions-item>
      <el-descriptions-item label="Inventory">
        <el-button link type="primary" @click="router.push(refRoute(item.spec.inventoryRef, namespace))">
          {{ item.spec.inventoryRef.kind }}/{{ item.spec.inventoryRef.name }}
        </el-button>
      </el-descriptions-item>
      <el-descriptions-item label="Failed step">{{ item.status?.failedStep ?? '—' }}</el-descriptions-item>
      <el-descriptions-item label="Started">{{ item.status?.startTime ? new Date(item.status.startTime).toLocaleString() : '—' }}</el-descriptions-item>
      <el-descriptions-item label="Completed">{{ item.status?.completionTime ? new Date(item.status.completionTime).toLocaleString() : '—' }}</el-descriptions-item>
    </el-descriptions>

    <div style="display: flex; gap: 8px; margin-bottom: 16px">
      <el-button v-if="!isTerminal(item.status?.phase)" type="warning" @click="cancel">Cancel</el-button>
      <el-button v-else type="primary" @click="retry">Retry</el-button>
    </div>

    <template v-if="item.status?.shards?.length">
      <h3>Shards ({{ item.status.shards.length }})</h3>
      <el-table
        :data="item.status.shards"
        border
        style="margin-bottom: 12px"
        :row-class-name="shardRowClassName"
        @row-click="(row: RunShardStatus) => (selectedShard = row.index)"
      >
        <el-table-column prop="index" label="#" width="60" />
        <el-table-column label="Hosts">
          <template #default="{ row }">{{ row.hosts.join(', ') || '—' }}</template>
        </el-table-column>
        <el-table-column label="Phase" width="120">
          <template #default="{ row }">
            <el-tag :type="phaseType(row.phase)">{{ row.phase ?? 'Pending' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="Exit code" width="90">
          <template #default="{ row }">{{ row.exitCode ?? '—' }}</template>
        </el-table-column>
        <el-table-column label="Failed step" width="140">
          <template #default="{ row }">{{ row.failedStep ?? '—' }}</template>
        </el-table-column>
        <el-table-column label="Logs" width="90">
          <template #default="{ row }">
            <el-button link type="primary" @click.stop="selectedShard = row.index">View</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-radio-group
        :model-value="selectedShard ?? 'all'"
        style="margin-bottom: 16px"
        @update:model-value="(v: number | 'all') => (selectedShard = v === 'all' ? undefined : v)"
      >
        <el-radio-button value="all">All shards</el-radio-button>
        <el-radio-button v-for="s in item.status.shards" :key="s.index" :value="s.index">
          #{{ s.index }}
        </el-radio-button>
      </el-radio-group>
    </template>

    <h3>
      Logs
      <small style="font-weight: normal">
        {{ selectedShard !== undefined ? `(shard ${selectedShard})` : item.status?.shards?.length ? '(all shards)' : '' }}
      </small>
    </h3>
    <el-alert v-if="logError" :title="logError" type="warning" style="margin-bottom: 12px" />
    <div
      ref="logContainer"
      style="background: #1e1e1e; color: #d4d4d4; font-family: monospace; padding: 16px; height: 60vh; overflow-y: auto; white-space: pre-wrap"
    >
      <div v-for="(line, i) in logLines" :key="i" v-html="line" />
    </div>
    <div style="margin-top: 12px">
      <el-button @click="downloadLogs">Download logs</el-button>
    </div>
  </div>
</template>

<style scoped>
:deep(.el-table__row) {
  cursor: pointer;
}
:deep(.el-table__row.is-selected-shard td) {
  background-color: var(--el-color-primary-light-9);
}
</style>
