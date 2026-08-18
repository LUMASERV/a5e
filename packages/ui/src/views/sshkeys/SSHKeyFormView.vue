<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { API_GROUP_VERSION } from '@a5e/schemas';
import { useNamespaceStore } from '../../stores/namespace';
import { useSSHKeyStore } from '../../stores/resources';
import { apiClient } from '../../api/client';

const router = useRouter();
const namespaceStore = useNamespaceStore();
const store = useSSHKeyStore();

type Mode = 'existing' | 'upload' | 'generate';
const mode = ref<Mode>('generate');
const form = reactive({
  name: '',
  secretName: '',
  secretKey: 'ssh-privatekey',
  passphraseSecretName: '',
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
  const namespace = namespaceStore.current;
  try {
    if (mode.value === 'existing') {
      await store.create(
        {
          apiVersion: API_GROUP_VERSION,
          kind: 'AnsibleSSHKey',
          metadata: { name: form.name, namespace },
          spec: {
            secretRef: { name: form.secretName, key: form.secretKey || undefined },
            passphraseSecretRef: form.passphraseSecretName
              ? { name: form.passphraseSecretName, key: form.passphraseSecretKey || undefined }
              : undefined,
          },
        },
        namespace,
      );
    } else {
      await apiClient.post(`/namespaces/${namespace}/ansiblesshkeys/import`, {
        name: form.name,
        mode: mode.value,
        keyType: form.keyType,
        privateKey: mode.value === 'upload' ? form.privateKey : undefined,
        passphrase: form.passphrase || undefined,
      });
    }
    ElMessage.success('Saved');
    router.push('/sshkeys');
  } catch (err) {
    ElMessage.error((err as Error).message);
  }
}
</script>

<template>
  <div>
    <h2>New SSH Key</h2>
    <el-form label-width="160px">
      <el-form-item label="Name">
        <el-input v-model="form.name" />
      </el-form-item>
      <el-form-item label="Source">
        <el-radio-group v-model="mode">
          <el-radio-button value="generate">Generate</el-radio-button>
          <el-radio-button value="upload">Upload file</el-radio-button>
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
        <el-alert
          type="info"
          :closable="false"
          title="The private key must already exist as a Kubernetes Secret in this namespace — this form only points at it."
          style="margin-bottom: 16px"
        />
        <el-form-item label="Secret name">
          <el-input v-model="form.secretName" />
        </el-form-item>
        <el-form-item label="Secret key">
          <el-input v-model="form.secretKey" placeholder="ssh-privatekey" />
        </el-form-item>
        <el-form-item label="Passphrase secret">
          <el-input v-model="form.passphraseSecretName" placeholder="optional — only if the key is encrypted" />
        </el-form-item>
        <el-form-item v-if="form.passphraseSecretName" label="Passphrase secret key">
          <el-input v-model="form.passphraseSecretKey" placeholder="passphrase" />
        </el-form-item>
      </template>

      <el-form-item>
        <el-button type="primary" @click="save">Save</el-button>
      </el-form-item>
    </el-form>
  </div>
</template>
