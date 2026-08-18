<script setup lang="ts">
import { onMounted } from 'vue';
import {
  Monitor,
  Files,
  Document,
  Key,
  VideoPlay,
  Timer,
  Setting,
  Odometer,
  Connection,
} from '@element-plus/icons-vue';
import { useAuthStore } from '../stores/auth';
import { useNamespaceStore } from '../stores/namespace';

const auth = useAuthStore();
const namespaceStore = useNamespaceStore();

onMounted(() => {
  namespaceStore.load();
});

const navGroups = [
  {
    title: 'Namespaced',
    items: [
      { label: 'Hosts', path: '/hosts', icon: Monitor },
      { label: 'Inventories', path: '/inventories', icon: Files },
      { label: 'Playbooks', path: '/playbooks', icon: Document },
      { label: 'SSH Keys', path: '/sshkeys', icon: Key },
      { label: 'Runs', path: '/runs', icon: VideoPlay },
      { label: 'Jobs', path: '/jobs', icon: Timer },
    ],
  },
  {
    title: 'Cluster-wide',
    items: [
      { label: 'Cluster Hosts', path: '/cluster-hosts', icon: Monitor },
      { label: 'Cluster Inventories', path: '/cluster-inventories', icon: Files },
      { label: 'Cluster Playbooks', path: '/cluster-playbooks', icon: Document },
      { label: 'Cluster SSH Keys', path: '/cluster-sshkeys', icon: Key },
    ],
  },
];
</script>

<template>
  <el-container style="height: 100vh">
    <el-aside width="220px" style="border-right: 1px solid var(--el-border-color)">
      <div style="padding: 16px; font-weight: 600">A5E</div>
      <el-menu :default-active="$route.path" router>
        <el-menu-item index="/">
          <el-icon><Odometer /></el-icon>
          <span>Dashboard</span>
        </el-menu-item>
        <el-sub-menu v-for="group in navGroups" :key="group.title" :index="group.title">
          <template #title>
            <el-icon><Connection /></el-icon>
            <span>{{ group.title }}</span>
          </template>
          <el-menu-item v-for="item in group.items" :key="item.path" :index="item.path">
            <el-icon><component :is="item.icon" /></el-icon>
            <span>{{ item.label }}</span>
          </el-menu-item>
        </el-sub-menu>
        <el-sub-menu v-if="auth.isAdmin" index="settings">
          <template #title>
            <el-icon><Setting /></el-icon>
            <span>Settings</span>
          </template>
          <el-menu-item index="/settings/s3">
            <span>S3</span>
          </el-menu-item>
          <el-menu-item index="/settings/oidc">
            <span>OIDC login</span>
          </el-menu-item>
          <el-menu-item index="/settings/users">
            <span>Users</span>
          </el-menu-item>
        </el-sub-menu>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--el-border-color)">
        <el-select
          v-if="namespaceStore.namespaces.length"
          :model-value="namespaceStore.current"
          style="width: 200px"
          @update:model-value="namespaceStore.setCurrent"
        >
          <el-option v-for="ns in namespaceStore.namespaces" :key="ns" :label="ns" :value="ns" />
        </el-select>
        <div v-else />
        <div style="display: flex; align-items: center; gap: 12px">
          <span v-if="auth.session">{{ auth.session.displayName }}</span>
          <el-button size="small" @click="auth.logout">Log out</el-button>
        </div>
      </el-header>
      <el-main>
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>
