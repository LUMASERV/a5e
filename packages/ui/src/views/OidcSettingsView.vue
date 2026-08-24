<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { onMounted, reactive, ref } from 'vue';
import { apiClient } from '../api/client';

interface OidcConfigResponse {
  issuer: string;
  clientId: string;
  hasClientSecret: boolean;
  scopes: string;
  redirectUri: string;
  configured: boolean;
}

const loading = ref(true);
const saving = ref(false);
const hasClientSecret = ref(false);
const redirectUri = ref('');
const configured = ref(false);

const form = reactive({ issuer: '', clientId: '', clientSecret: '', scopes: '' });

async function load() {
  loading.value = true;
  try {
    const result = await apiClient.get<OidcConfigResponse>('/config/oidc');
    form.issuer = result.issuer;
    form.clientId = result.clientId;
    form.scopes = result.scopes;
    hasClientSecret.value = result.hasClientSecret;
    redirectUri.value = result.redirectUri;
    configured.value = result.configured;
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  try {
    await apiClient.replace('/config/oidc', {
      issuer: form.issuer,
      clientId: form.clientId,
      clientSecret: form.clientSecret || undefined,
      scopes: form.scopes || undefined,
    });
    form.clientSecret = '';
    ElMessage.success('Saved');
    await load();
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    saving.value = false;
  }
}

async function copyRedirectUri() {
  await navigator.clipboard.writeText(redirectUri.value);
  ElMessage.success('Copied');
}

onMounted(load);
</script>

<template>
  <div>
    <h2>OIDC login</h2>
    <el-alert
      :title="configured ? 'OIDC is configured' : 'OIDC is not configured yet — logins will fail until this is saved'"
      :type="configured ? 'success' : 'warning'"
      :closable="false"
      style="margin-bottom: 16px; max-width: 700px"
    />

    <el-form v-loading="loading" label-width="160px" style="max-width: 700px">
      <el-form-item label="Redirect URI">
        <el-input :model-value="redirectUri" readonly>
          <template #append>
            <el-button @click="copyRedirectUri">Copy</el-button>
          </template>
        </el-input>
        <div style="font-size: 12px; color: var(--el-text-color-secondary); margin-top: 4px">
          Register this exact URI as an allowed redirect URI on your IdP client. It's derived from
          UI_ORIGIN — changing it means redeploying with a different UI_ORIGIN, not editing it here.
        </div>
      </el-form-item>

      <el-form-item label="Issuer">
        <el-input v-model="form.issuer" placeholder="https://idp.example.com/realms/example" />
      </el-form-item>
      <el-form-item label="Client ID">
        <el-input v-model="form.clientId" />
      </el-form-item>
      <el-form-item label="Client secret">
        <el-input
          v-model="form.clientSecret"
          type="password"
          show-password
          :placeholder="hasClientSecret ? 'leave blank to keep the existing secret' : 'required'"
        />
      </el-form-item>
      <el-form-item label="Scopes">
        <el-input v-model="form.scopes" placeholder="openid profile" />
        <div style="font-size: 12px; color: var(--el-text-color-secondary); margin-top: 4px">
          Space-separated. "groups" and even "email" aren't guaranteed to exist on every IdP client
          — add "email" if you want local-account linking by email, and "groups" (or your IdP's
          equivalent) for group-based RBAC, only once your IdP client actually supports them.
        </div>
      </el-form-item>

      <el-form-item>
        <el-button type="primary" :loading="saving" @click="save">Save</el-button>
      </el-form-item>
    </el-form>
  </div>
</template>
