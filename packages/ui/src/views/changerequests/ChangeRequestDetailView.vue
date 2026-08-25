<script setup lang="ts">
import type { ChangeRequestSpec, ChangeRequestStatus, CustomResource } from '@a5e/schemas';
import { ElMessage } from 'element-plus';
import { computed, onMounted, ref } from 'vue';
import { apiClient } from '../../api/client';
import ChangeItemCard from '../../components/ChangeItemCard.vue';
import { useChangeRequestStore } from '../../stores/resources';

const props = defineProps<{ name: string }>();
const store = useChangeRequestStore();
const item = ref<CustomResource<ChangeRequestSpec, ChangeRequestStatus> | null>(null);
const busy = ref(false);
const declineDialogVisible = ref(false);
const declineReason = ref('');

function phaseType(phase?: string): 'success' | 'danger' | 'warning' | 'info' {
  if (phase === 'Applied') return 'success';
  if (phase === 'Declined' || phase === 'Failed') return 'danger';
  if (phase === 'Approved') return 'warning';
  return 'info';
}

async function load() {
  item.value = await store.get(props.name);
}
onMounted(load);

const isPending = computed(() => (item.value?.status?.phase ?? 'Pending') === 'Pending');

function resultFor(index: number) {
  return item.value?.status?.results?.find((r) => r.index === index);
}

async function approve() {
  busy.value = true;
  try {
    await apiClient.post(`/changerequests/${props.name}/approve`);
    ElMessage.success('Change request approved and applied');
    await load();
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    busy.value = false;
  }
}

async function decline() {
  busy.value = true;
  try {
    await apiClient.post(`/changerequests/${props.name}/decline`, { reason: declineReason.value });
    ElMessage.success('Change request declined');
    declineDialogVisible.value = false;
    await load();
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="item">
    <h2>Change request</h2>
    <el-descriptions :column="2" border style="margin-bottom: 16px">
      <el-descriptions-item label="Requested by">{{ item.spec.requestedByName }}</el-descriptions-item>
      <el-descriptions-item label="Requested at">{{ new Date(item.spec.requestedAt).toLocaleString() }}</el-descriptions-item>
      <el-descriptions-item label="Phase">
        <el-tag :type="phaseType(item.status?.phase)">{{ item.status?.phase ?? 'Pending' }}</el-tag>
      </el-descriptions-item>
      <el-descriptions-item label="Reason">{{ item.spec.reason ?? '—' }}</el-descriptions-item>
      <el-descriptions-item v-if="item.status?.reviewedByName" label="Reviewed by">{{ item.status.reviewedByName }}</el-descriptions-item>
      <el-descriptions-item v-if="item.status?.reviewedAt" label="Reviewed at">{{ new Date(item.status.reviewedAt).toLocaleString() }}</el-descriptions-item>
      <el-descriptions-item v-if="item.status?.declineReason" label="Decline reason">{{ item.status.declineReason }}</el-descriptions-item>
    </el-descriptions>

    <div v-for="(change, index) in item.spec.changes" :key="index">
      <ChangeItemCard :item="change" />
      <el-alert
        v-if="resultFor(index)"
        :type="resultFor(index)!.status === 'Applied' ? 'success' : resultFor(index)!.status === 'Failed' ? 'error' : 'info'"
        :title="`${resultFor(index)!.status}${resultFor(index)!.error ? ': ' + resultFor(index)!.error : ''}`"
        style="margin: -8px 0 12px"
      />
    </div>

    <div v-if="isPending" style="display: flex; gap: 8px; margin-top: 16px">
      <el-button type="primary" :loading="busy" @click="approve">Approve</el-button>
      <el-button type="danger" :loading="busy" @click="declineDialogVisible = true">Decline</el-button>
    </div>

    <el-dialog v-model="declineDialogVisible" title="Decline change request" width="480px">
      <el-form-item label="Reason">
        <el-input v-model="declineReason" type="textarea" :rows="3" />
      </el-form-item>
      <template #footer>
        <el-button @click="declineDialogVisible = false">Cancel</el-button>
        <el-button type="danger" :loading="busy" @click="decline">Decline</el-button>
      </template>
    </el-dialog>
  </div>
</template>
