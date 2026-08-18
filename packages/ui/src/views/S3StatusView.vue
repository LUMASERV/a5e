<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { apiClient } from '../api/client';

const configured = ref<boolean | null>(null);

onMounted(async () => {
  const result = await apiClient.get<{ configured: boolean }>('/config/s3-status');
  configured.value = result.configured;
});
</script>

<template>
  <div>
    <h2>Settings</h2>
    <el-descriptions :column="1" border>
      <el-descriptions-item label="S3 log archival">
        <el-tag v-if="configured === true" type="success">Configured</el-tag>
        <el-tag v-else-if="configured === false" type="info">Not configured — logs are read live from the run's Pod</el-tag>
        <span v-else>Loading…</span>
      </el-descriptions-item>
    </el-descriptions>
  </div>
</template>
