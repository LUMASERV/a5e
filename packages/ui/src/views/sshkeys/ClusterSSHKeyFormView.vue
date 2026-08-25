<script setup lang="ts">
import { API_GROUP_VERSION } from '@a5e/schemas';
import { ElMessage } from 'element-plus';
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { apiClient } from '../../api/client';
import LabelsEditor from '../../components/LabelsEditor.vue';
import { useChangeRequestDraftStore } from '../../stores/changeRequestDraft';
import { useNamespaceStore } from '../../stores/namespace';
import { useClusterSSHKeyStore } from '../../stores/resources';

const router = useRouter();
const store = useClusterSSHKeyStore();
const namespaceStore = useNamespaceStore();
const draftStore = useChangeRequestDraftStore();

type Mode = 'existing' | 'upload' | 'generate';
const mode = ref<Mode>(draftStore.isActive ? 'existing' : 'generate');
const labels = ref<Record<string, string> | undefined>(undefined);
const form = reactive({
  name: '',
  secretName: '',
  secretNamespace: '',
  secretKey: 'ssh-privatekey',
  passphraseSecretName: '',
  passphraseSecretNamespace: '',
  passphraseSecretKey: 'passphrase',
  privateKey: '',
  passphrase: '',
  keyType: 'ed25519' as 'ed25519' | 'rsa',
});
const uploadFileName = ref('');

function onFileChange(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  uploadFileName.value = file.name;
  const reader = new FileReader();
  reader.onload = () => {
    form.privateKey = String(reader.result ?? '');
  };
  reader.readAsText(file);
}

async function save() {
  try {
    if (mode.value === 'existing') {
      await store.create({
        apiVersion: API_GROUP_VERSION,
        kind: 'ClusterAnsibleSSHKey',
        metadata: { name: form.name, labels: labels.value },
        spec: {
          secretRef: {
            name: form.secretName,
            namespace: form.secretNamespace,
            key: form.secretKey || undefined,
          },
          passphraseSecretRef: form.passphraseSecretName
            ? {
                name: form.passphraseSecretName,
                namespace: form.passphraseSecretNamespace || form.secretNamespace,
                key: form.passphraseSecretKey || undefined,
              }
            : undefined,
        },
      });
    } else {
      await apiClient.post('/clusteransiblesshkeys/import', {
        name: form.name,
        mode: mode.value,
        keyType: form.keyType,
        privateKey: mode.value === 'upload' ? form.privateKey : undefined,
        passphrase: form.passphrase || undefined,
        secretNamespace: form.secretNamespace || namespaceStore.current,
        labels: labels.value,
      });
    }
    ElMessage.success(draftStore.isActive ? 'Added to change request draft' : 'Saved');
    router.push('/cluster-sshkeys');
  } catch (err) {
    ElMessage.error((err as Error).message);
  }
}
</script>

<template>
  <div>
    <h2>New Cluster SSH Key</h2>
    <el-alert
      type="info"
      :closable="false"
      title="Cluster-scoped keys require an explicit Secret namespace — there's no owning namespace to default to."
      style="margin-bottom: 16px"
    />
    <el-alert
      v-if="draftStore.isActive"
      type="info"
      :closable="false"
      title="Generate and Upload aren't stageable in a change request — use Existing secret, or finish/cancel your draft first."
      style="margin-bottom: 16px"
    />
    <el-form label-width="160px">
      <el-form-item label="Name">
        <el-input v-model="form.name" />
      </el-form-item>
      <el-form-item label="Secret namespace">
        <el-input v-model="form.secretNamespace" :placeholder="mode !== 'existing' ? `defaults to ${namespaceStore.current}` : ''" />
      </el-form-item>
      <el-form-item label="Source">
        <el-radio-group v-model="mode">
          <el-radio-button value="generate" :disabled="draftStore.isActive">Generate</el-radio-button>
          <el-radio-button value="upload" :disabled="draftStore.isActive">Upload file</el-radio-button>
          <el-radio-button value="existing">Existing secret</el-radio-button>
        </el-radio-group>
      </el-form-item>

      <template v-if="mode === 'generate'">
        <el-form-item label="Key type">
          <el-select v-model="form.keyType">
            <el-option label="ed25519" value="ed25519" />
            <el-option label="RSA (4096)" value="rsa" />
          </el-select>
        </el-form-item>
      </template>

      <template v-else-if="mode === 'upload'">
        <el-form-item label="Private key file">
          <input type="file" @change="onFileChange" />
          <span v-if="uploadFileName" style="margin-left: 8px; color: var(--el-text-color-secondary)">{{ uploadFileName }}</span>
        </el-form-item>
        <el-form-item label="Passphrase">
          <el-input v-model="form.passphrase" type="password" show-password placeholder="optional — only if the key is encrypted" />
        </el-form-item>
      </template>

      <template v-else>
        <el-form-item label="Secret name">
          <el-input v-model="form.secretName" />
        </el-form-item>
        <el-form-item label="Secret key">
          <el-input v-model="form.secretKey" placeholder="ssh-privatekey" />
        </el-form-item>
        <el-form-item label="Passphrase secret">
          <el-input v-model="form.passphraseSecretName" placeholder="optional — only if the key is encrypted" />
        </el-form-item>
        <template v-if="form.passphraseSecretName">
          <el-form-item label="Passphrase secret namespace">
            <el-input v-model="form.passphraseSecretNamespace" :placeholder="`defaults to ${form.secretNamespace}`" />
          </el-form-item>
          <el-form-item label="Passphrase secret key">
            <el-input v-model="form.passphraseSecretKey" placeholder="passphrase" />
          </el-form-item>
        </template>
      </template>

      <el-form-item>
        <el-button type="primary" @click="save">Save</el-button>
      </el-form-item>
    </el-form>
  </div>
</template>
