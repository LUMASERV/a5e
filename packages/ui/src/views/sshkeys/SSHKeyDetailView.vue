<script setup lang="ts">
import type { AnsibleSSHKeySpec, AnsibleSSHKeyStatus, CustomResource } from '@a5e/schemas';
import { ElMessage, ElMessageBox } from 'element-plus';
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useSSHKeyStore } from '../../stores/resources';

const props = defineProps<{ namespace: string; name: string }>();
const router = useRouter();
const store = useSSHKeyStore();
const item = ref<CustomResource<AnsibleSSHKeySpec, AnsibleSSHKeyStatus> | null>(null);

onMounted(async () => {
  item.value = await store.get(props.name, props.namespace);
});

async function remove() {
  try {
    await ElMessageBox.confirm(`Delete ${props.name}?`, 'Confirm', { type: 'warning' });
  } catch {
    return;
  }
  await store.remove(props.name, props.namespace);
  ElMessage.success('Deleted');
  router.push('/sshkeys');
}
</script>

<template>
  <div v-if="item">
    <h2>{{ item.metadata.name }}</h2>
    <el-descriptions :column="1" border>
      <el-descriptions-item label="Namespace">{{ item.metadata.namespace }}</el-descriptions-item>
      <el-descriptions-item label="Secret">{{ item.spec.secretRef.name }} / {{ item.spec.secretRef.key ?? 'ssh-privatekey' }}</el-descriptions-item>
      <el-descriptions-item label="Key type">{{ item.status?.keyType ?? '—' }}</el-descriptions-item>
      <el-descriptions-item label="Fingerprint">{{ item.status?.fingerprint ?? '—' }}</el-descriptions-item>
      <el-descriptions-item label="Public key">
        <el-input v-if="item.status?.publicKey" type="textarea" :rows="3" readonly :model-value="item.status.publicKey" />
        <span v-else>—</span>
      </el-descriptions-item>
    </el-descriptions>
    <el-button type="danger" style="margin-top: 16px" @click="remove">Delete</el-button>
  </div>
</template>
