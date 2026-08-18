<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import DefaultLayout from './layouts/DefaultLayout.vue';

const route = useRoute();
// `public` (no session required) and `bare` (session required, but still no sidebar chrome —
// e.g. /no-access) are independent concerns; either one skips DefaultLayout here.
const bareLayout = computed(() => route.meta.public === true || route.meta.bare === true);
</script>

<template>
  <DefaultLayout v-if="!bareLayout">
    <router-view />
  </DefaultLayout>
  <router-view v-else />
</template>
