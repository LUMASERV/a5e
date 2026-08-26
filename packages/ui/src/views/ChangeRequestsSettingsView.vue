<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { onMounted, ref } from 'vue';
import { useAppSettingsStore } from '../stores/appSettings';

const appSettings = useAppSettingsStore();
const loading = ref(true);
const saving = ref(false);

onMounted(async () => {
  try {
    await appSettings.load();
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    loading.value = false;
  }
});

async function onToggle(value: string | number | boolean) {
  const previous = !value;
  saving.value = true;
  try {
    await appSettings.setChangeRequestsEnabled(Boolean(value));
    ElMessage.success('Saved');
  } catch (err) {
    appSettings.changeRequestsEnabled = previous;
    ElMessage.error((err as Error).message);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div>
    <h2>Change requests</h2>
    <el-form v-loading="loading" label-width="220px" style="max-width: 700px">
      <el-form-item label="Allow change requests">
        <el-switch
          :model-value="appSettings.changeRequestsEnabled"
          :loading="saving"
          @change="onToggle"
        />
        <div style="font-size: 12px; color: var(--el-text-color-secondary); margin-top: 4px">
          When enabled, any logged-in user can stage create/update/delete changes into a change
          request for someone with "approve" permission to review and apply — including a
          "submit as change request instead?" prompt when a direct action is denied. Turning this
          off removes the "Start change request" button and the Change Requests nav item for
          everyone, and blocks submitting new requests. Any requests already pending stay visible
          and can still be approved, declined, or withdrawn.
        </div>
      </el-form-item>
    </el-form>
  </div>
</template>
