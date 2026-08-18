<script setup lang="ts">
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
</script>

<template>
  <div style="display: flex; align-items: center; justify-content: center; height: 100vh">
    <el-card style="width: 420px; text-align: center">
      <h2>No access yet</h2>
      <p style="color: var(--el-text-color-secondary)">
        You're signed in as <strong>{{ auth.session?.displayName }}</strong>, but no role has been
        assigned to your account yet. Ask an administrator to grant you access in Settings →
        Local accounts or SSO users.
      </p>
      <el-button style="margin-top: 8px" @click="auth.logout">Log out</el-button>
    </el-card>
  </div>
</template>
