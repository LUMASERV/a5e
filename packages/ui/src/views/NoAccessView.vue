<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const router = useRouter();
</script>

<template>
  <div style="display: flex; align-items: center; justify-content: center; height: 100vh">
    <el-card style="width: 420px; text-align: center">
      <h2>No access yet</h2>
      <p style="color: var(--el-text-color-secondary)">
        You're signed in as <strong>{{ auth.session?.displayName }}</strong>, but no role has been
        assigned to your account yet. Ask an administrator to grant you access in Settings → Users.
      </p>
      <div style="display: flex; gap: 8px; justify-content: center; margin-top: 8px">
        <el-button @click="router.push('/account')">My account</el-button>
        <el-button @click="auth.logout">Log out</el-button>
      </div>
    </el-card>
  </div>
</template>
