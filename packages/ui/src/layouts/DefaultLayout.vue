<script setup lang="ts">
import {
  Connection,
  Document,
  Files,
  Key,
  Monitor,
  Odometer,
  Setting,
  Tickets,
  Timer,
  VideoPlay,
} from '@element-plus/icons-vue';
import { onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useAppSettingsStore } from '../stores/appSettings';
import { useAuthStore } from '../stores/auth';
import { useChangeRequestDraftStore } from '../stores/changeRequestDraft';
import { useNamespaceStore } from '../stores/namespace';

const auth = useAuthStore();
const namespaceStore = useNamespaceStore();
const appSettings = useAppSettingsStore();
const draftStore = useChangeRequestDraftStore();
const router = useRouter();

onMounted(() => {
  namespaceStore.load();
  appSettings.load();
});

// `App.vue` renders DefaultLayout as soon as the router's *initial* placeholder route resolves
// `meta.public`/`meta.bare` to false — which happens before the router's own beforeEach guard has
// actually awaited auth.check() on a hard reload. Rehydrating on plain onMounted would then run
// with auth.session still null, silently finding no identity to key the stored draft by. Watch
// for the session to actually become available instead (immediate covers the normal case where
// it's already set by the time this component mounts, e.g. right after a login redirect).
watch(
  () => auth.session,
  (session) => {
    if (session) draftStore.rehydrate();
  },
  { immediate: true },
);

// Starting a draft is deliberately not a navigation — the whole point is to keep browsing the
// page you're already on and stage changes as you go. Only once a draft is under way does the
// button become the entry point into reviewing it.
function onChangeRequestButtonClick() {
  if (!draftStore.started) {
    draftStore.start();
  } else {
    router.push('/change-requests/draft');
  }
}

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
        <el-menu-item v-if="appSettings.changeRequestsEnabled" index="/change-requests">
          <el-icon><Tickets /></el-icon>
          <span>Change Requests</span>
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
          <el-menu-item index="/settings/groups">
            <span>Groups</span>
          </el-menu-item>
          <el-menu-item index="/settings/change-requests">
            <span>Change Requests</span>
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
          <el-button
            v-if="appSettings.changeRequestsEnabled"
            size="small"
            :type="draftStore.started ? 'warning' : undefined"
            @click="onChangeRequestButtonClick"
          >
            {{ draftStore.started ? `Change request (${draftStore.items.length})` : 'Start change request' }}
          </el-button>
          <el-button v-if="auth.session" link @click="router.push('/account')">
            {{ auth.session.displayName }}
          </el-button>
          <el-button size="small" @click="auth.logout">Log out</el-button>
        </div>
      </el-header>
      <el-main>
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>
