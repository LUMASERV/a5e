<script setup lang="ts">
import { computed } from 'vue';
import type { PlaybookSource } from '@a5e/schemas';

const props = defineProps<{ modelValue: PlaybookSource }>();
const emit = defineEmits<{ 'update:modelValue': [PlaybookSource] }>();

type Kind = 'inline' | 'configMapRef' | 'git';
const kind = computed<Kind>(() => {
  if (props.modelValue.git) return 'git';
  if (props.modelValue.configMapRef) return 'configMapRef';
  return 'inline';
});

function setKind(next: Kind) {
  if (next === 'inline') emit('update:modelValue', { inline: { playbook: '' } });
  else if (next === 'configMapRef') emit('update:modelValue', { configMapRef: { name: '' } });
  else emit('update:modelValue', { git: { url: '' } });
}

function updateInline(playbook: string) {
  emit('update:modelValue', { inline: { playbook } });
}
function updateConfigMapRef(patch: Partial<{ name: string; namespace: string; key: string }>) {
  emit('update:modelValue', { configMapRef: { ...props.modelValue.configMapRef, name: '', ...patch } });
}
function updateGit(
  patch: Partial<{
    url: string;
    revision: string;
    path: string;
    sshKeySecretRef: { name: string; namespace?: string } | undefined;
    basicAuthSecretRef: { name: string; namespace?: string } | undefined;
  }>,
) {
  emit('update:modelValue', { git: { ...props.modelValue.git, url: '', ...patch } });
}

type GitAuthMode = 'none' | 'ssh' | 'basic';
const gitAuthMode = computed<GitAuthMode>(() => {
  if (props.modelValue.git?.sshKeySecretRef) return 'ssh';
  if (props.modelValue.git?.basicAuthSecretRef) return 'basic';
  return 'none';
});
function setGitAuthMode(mode: GitAuthMode) {
  updateGit({
    sshKeySecretRef: mode === 'ssh' ? { name: '' } : undefined,
    basicAuthSecretRef: mode === 'basic' ? { name: '' } : undefined,
  });
}
</script>

<template>
  <div style="width: 100%">
    <el-radio-group :model-value="kind" style="margin-bottom: 12px" @update:model-value="setKind">
      <el-radio-button value="inline">Inline</el-radio-button>
      <el-radio-button value="configMapRef">ConfigMap</el-radio-button>
      <el-radio-button value="git">Git</el-radio-button>
    </el-radio-group>

    <el-input
      v-if="kind === 'inline'"
      type="textarea"
      :rows="10"
      :model-value="modelValue.inline?.playbook"
      placeholder="- hosts: all&#10;  tasks: ..."
      @update:model-value="updateInline"
    />

    <div v-else-if="kind === 'configMapRef'">
      <el-form-item label="ConfigMap name">
        <el-input :model-value="modelValue.configMapRef?.name" @update:model-value="(v: string | number) => updateConfigMapRef({ name: v as string })" />
      </el-form-item>
      <el-form-item label="Namespace (optional)">
        <el-input :model-value="modelValue.configMapRef?.namespace" @update:model-value="(v: string | number) => updateConfigMapRef({ namespace: v as string })" />
      </el-form-item>
      <el-form-item label="Key (default playbook.yml)">
        <el-input :model-value="modelValue.configMapRef?.key" @update:model-value="(v: string | number) => updateConfigMapRef({ key: v as string })" />
      </el-form-item>
    </div>

    <div v-else>
      <el-form-item label="Repository URL">
        <el-input :model-value="modelValue.git?.url" @update:model-value="(v: string | number) => updateGit({ url: v as string })" />
      </el-form-item>
      <el-form-item label="Revision (default main)">
        <el-input :model-value="modelValue.git?.revision" @update:model-value="(v: string | number) => updateGit({ revision: v as string })" />
      </el-form-item>
      <el-form-item label="Path in repo">
        <el-input :model-value="modelValue.git?.path" @update:model-value="(v: string | number) => updateGit({ path: v as string })" />
      </el-form-item>
      <el-form-item label="Auth">
        <el-radio-group :model-value="gitAuthMode" @update:model-value="(v: string | number) => setGitAuthMode(v as GitAuthMode)">
          <el-radio-button value="none">None</el-radio-button>
          <el-radio-button value="ssh">SSH key</el-radio-button>
          <el-radio-button value="basic">Basic auth</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <template v-if="gitAuthMode === 'ssh'">
        <el-form-item label="Secret name">
          <el-input
            :model-value="modelValue.git?.sshKeySecretRef?.name"
            placeholder="AnsibleSSHKey-style Secret with an ssh-privatekey key"
            @update:model-value="(v: string | number) => updateGit({ sshKeySecretRef: { ...modelValue.git?.sshKeySecretRef, name: String(v) } })"
          />
        </el-form-item>
        <el-form-item label="Secret namespace">
          <el-input
            :model-value="modelValue.git?.sshKeySecretRef?.namespace"
            placeholder="defaults to this playbook's namespace"
            @update:model-value="(v: string | number) => updateGit({ sshKeySecretRef: { ...modelValue.git?.sshKeySecretRef, name: modelValue.git?.sshKeySecretRef?.name ?? '', namespace: String(v) } })"
          />
        </el-form-item>
      </template>
      <template v-else-if="gitAuthMode === 'basic'">
        <el-form-item label="Secret name">
          <el-input
            :model-value="modelValue.git?.basicAuthSecretRef?.name"
            placeholder="Secret with username/password keys"
            @update:model-value="(v: string | number) => updateGit({ basicAuthSecretRef: { ...modelValue.git?.basicAuthSecretRef, name: String(v) } })"
          />
        </el-form-item>
        <el-form-item label="Secret namespace">
          <el-input
            :model-value="modelValue.git?.basicAuthSecretRef?.namespace"
            placeholder="defaults to this playbook's namespace"
            @update:model-value="(v: string | number) => updateGit({ basicAuthSecretRef: { ...modelValue.git?.basicAuthSecretRef, name: modelValue.git?.basicAuthSecretRef?.name ?? '', namespace: String(v) } })"
          />
        </el-form-item>
      </template>
    </div>
  </div>
</template>
