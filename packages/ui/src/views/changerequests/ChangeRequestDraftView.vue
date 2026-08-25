<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus';
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import ChangeItemCard from '../../components/ChangeItemCard.vue';
import { useChangeRequestDraftStore } from '../../stores/changeRequestDraft';
import { useChangeRequestStore } from '../../stores/resources';

const draftStore = useChangeRequestDraftStore();
const changeRequestStore = useChangeRequestStore();
const router = useRouter();
const submitting = ref(false);

async function cancelDraft() {
  try {
    await ElMessageBox.confirm('Discard this entire change request draft?', 'Confirm', {
      type: 'warning',
    });
  } catch {
    return;
  }
  draftStore.cancel();
  router.push('/');
}

async function submit() {
  submitting.value = true;
  try {
    const created = await changeRequestStore.create({
      spec: {
        reason: draftStore.reason || undefined,
        changes: draftStore.items.map((item) => ({
          action: item.kind === 'delete' ? 'delete' : item.kind,
          type: item.type,
          namespace: item.namespace,
          name: item.name,
          body: item.body,
        })),
      },
    });
    draftStore.cancel();
    ElMessage.success('Change request submitted for review');
    router.push(`/change-requests/${created.metadata.name}`);
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div>
    <h2>Change request</h2>

    <el-empty v-if="!draftStore.started" description="No change request in progress">
      <el-button type="primary" @click="draftStore.start()">Start change request</el-button>
    </el-empty>

    <template v-else>
      <p style="color: var(--el-text-color-secondary); max-width: 700px">
        Browse the app normally — every create, update, or delete you make gets added here instead
        of applying immediately. Review the diff, remove anything you don't want, then submit for
        an admin to approve or decline. This draft survives a page reload.
      </p>

      <el-form-item label="Reason (optional)" style="max-width: 600px">
        <el-input
          type="textarea"
          :rows="2"
          :model-value="draftStore.reason"
          @update:model-value="(v: string) => draftStore.setReason(v)"
        />
      </el-form-item>

      <el-empty v-if="draftStore.items.length === 0" description="No changes staged yet — go make some" />
      <ChangeItemCard
        v-for="item in draftStore.items"
        :key="item.id"
        :item="{ action: item.kind, type: item.type, namespace: item.namespace, name: item.name, body: item.body }"
        :previous-body="item.previous"
        removable
        @remove="draftStore.removeItem(item.id)"
      />

      <div style="display: flex; gap: 8px; margin-top: 16px">
        <el-button @click="cancelDraft">Cancel change request</el-button>
        <el-button
          type="primary"
          :disabled="draftStore.items.length === 0"
          :loading="submitting"
          @click="submit"
        >
          Submit for review
        </el-button>
      </div>
    </template>
  </div>
</template>
