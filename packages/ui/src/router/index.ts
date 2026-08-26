import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const routes = [
  { path: '/', name: 'dashboard', component: () => import('../views/DashboardView.vue') },
  {
    path: '/login',
    name: 'login',
    component: () => import('../views/LoginView.vue'),
    meta: { public: true },
  },
  {
    path: '/auth/callback',
    name: 'auth-callback',
    component: () => import('../views/AuthCallbackView.vue'),
    // Public: the whole point of this route is to establish the session from the token in the
    // URL fragment (see auth/routes.ts's OIDC callback) — there's nothing to check yet when it
    // first loads. `public` alone already skips the DefaultLayout chrome (see App.vue).
    meta: { public: true },
  },
  {
    path: '/no-access',
    name: 'no-access',
    component: () => import('../views/NoAccessView.vue'),
    // Not `public` — an unauthenticated visitor should still be bounced to /login by the router
    // guard below. `bare` only controls whether App.vue skips the DefaultLayout sidebar chrome.
    meta: { bare: true },
  },
  {
    path: '/account',
    name: 'account',
    component: () => import('../views/AccountView.vue'),
    // Not `public` (still requires a session) but deliberately exempt from the hasAccess/
    // no-access redirect below, same reasoning as /whoami on the API side — a role:'none' user
    // should still be able to see their own identity and set up their own password.
  },

  { path: '/hosts', name: 'hosts', component: () => import('../views/hosts/HostListView.vue') },
  {
    path: '/hosts/new',
    name: 'hosts-new',
    component: () => import('../views/hosts/HostFormView.vue'),
  },
  {
    path: '/hosts/:namespace/:name/edit',
    name: 'hosts-edit',
    component: () => import('../views/hosts/HostFormView.vue'),
    props: true,
  },
  {
    path: '/cluster-hosts',
    name: 'cluster-hosts',
    component: () => import('../views/hosts/ClusterHostListView.vue'),
  },
  {
    path: '/cluster-hosts/new',
    name: 'cluster-hosts-new',
    component: () => import('../views/hosts/ClusterHostFormView.vue'),
  },
  {
    path: '/cluster-hosts/:name/edit',
    name: 'cluster-hosts-edit',
    component: () => import('../views/hosts/ClusterHostFormView.vue'),
    props: true,
  },

  {
    path: '/inventories',
    name: 'inventories',
    component: () => import('../views/inventories/InventoryListView.vue'),
  },
  {
    path: '/inventories/new',
    name: 'inventories-new',
    component: () => import('../views/inventories/InventoryFormView.vue'),
  },
  {
    path: '/inventories/:namespace/:name/edit',
    name: 'inventories-edit',
    component: () => import('../views/inventories/InventoryFormView.vue'),
    props: true,
  },
  {
    path: '/cluster-inventories',
    name: 'cluster-inventories',
    component: () => import('../views/inventories/ClusterInventoryListView.vue'),
  },
  {
    path: '/cluster-inventories/new',
    name: 'cluster-inventories-new',
    component: () => import('../views/inventories/ClusterInventoryFormView.vue'),
  },
  {
    path: '/cluster-inventories/:name/edit',
    name: 'cluster-inventories-edit',
    component: () => import('../views/inventories/ClusterInventoryFormView.vue'),
    props: true,
  },

  {
    path: '/playbooks',
    name: 'playbooks',
    component: () => import('../views/playbooks/PlaybookListView.vue'),
  },
  {
    path: '/playbooks/new',
    name: 'playbooks-new',
    component: () => import('../views/playbooks/PlaybookFormView.vue'),
  },
  {
    path: '/playbooks/:namespace/:name/edit',
    name: 'playbooks-edit',
    component: () => import('../views/playbooks/PlaybookFormView.vue'),
    props: true,
  },
  {
    path: '/cluster-playbooks',
    name: 'cluster-playbooks',
    component: () => import('../views/playbooks/ClusterPlaybookListView.vue'),
  },
  {
    path: '/cluster-playbooks/new',
    name: 'cluster-playbooks-new',
    component: () => import('../views/playbooks/ClusterPlaybookFormView.vue'),
  },
  {
    path: '/cluster-playbooks/:name/edit',
    name: 'cluster-playbooks-edit',
    component: () => import('../views/playbooks/ClusterPlaybookFormView.vue'),
    props: true,
  },

  {
    path: '/sshkeys',
    name: 'sshkeys',
    component: () => import('../views/sshkeys/SSHKeyListView.vue'),
  },
  {
    path: '/sshkeys/new',
    name: 'sshkeys-new',
    component: () => import('../views/sshkeys/SSHKeyFormView.vue'),
  },
  {
    path: '/sshkeys/:namespace/:name',
    name: 'sshkeys-detail',
    component: () => import('../views/sshkeys/SSHKeyDetailView.vue'),
    props: true,
  },
  {
    path: '/cluster-sshkeys',
    name: 'cluster-sshkeys',
    component: () => import('../views/sshkeys/ClusterSSHKeyListView.vue'),
  },
  {
    path: '/cluster-sshkeys/new',
    name: 'cluster-sshkeys-new',
    component: () => import('../views/sshkeys/ClusterSSHKeyFormView.vue'),
  },
  {
    path: '/cluster-sshkeys/:name',
    name: 'cluster-sshkeys-detail',
    component: () => import('../views/sshkeys/ClusterSSHKeyDetailView.vue'),
    props: true,
  },

  { path: '/runs', name: 'runs', component: () => import('../views/runs/RunListView.vue') },
  {
    path: '/runs/new',
    name: 'runs-new',
    component: () => import('../views/runs/RunTriggerView.vue'),
  },
  {
    path: '/runs/:namespace/:name',
    name: 'runs-detail',
    component: () => import('../views/runs/RunDetailView.vue'),
    props: true,
  },

  { path: '/jobs', name: 'jobs', component: () => import('../views/jobs/JobListView.vue') },
  { path: '/jobs/new', name: 'jobs-new', component: () => import('../views/jobs/JobFormView.vue') },
  {
    path: '/jobs/:namespace/:name/edit',
    name: 'jobs-edit',
    component: () => import('../views/jobs/JobFormView.vue'),
    props: true,
  },

  // Any logged-in user, not admin-gated — proposing a change is ungated for everyone, and who
  // can actually approve a submitted one is enforced server-side per-item, not by app role.
  {
    path: '/change-requests',
    name: 'change-requests',
    component: () => import('../views/changerequests/ChangeRequestListView.vue'),
  },
  {
    path: '/change-requests/draft',
    name: 'change-requests-draft',
    component: () => import('../views/changerequests/ChangeRequestDraftView.vue'),
  },
  {
    path: '/change-requests/:name',
    name: 'change-requests-detail',
    component: () => import('../views/changerequests/ChangeRequestDetailView.vue'),
    props: true,
  },

  {
    path: '/settings/s3',
    name: 'settings-s3',
    component: () => import('../views/S3StatusView.vue'),
    meta: { requiresAdmin: true },
  },
  {
    path: '/settings/oidc',
    name: 'settings-oidc',
    component: () => import('../views/OidcSettingsView.vue'),
    meta: { requiresAdmin: true },
  },
  {
    path: '/settings/users',
    name: 'settings-users',
    component: () => import('../views/UsersSettingsView.vue'),
    meta: { requiresAdmin: true },
  },
  {
    path: '/settings/users/:id/edit',
    name: 'settings-users-edit',
    component: () => import('../views/UserEditView.vue'),
    props: true,
    meta: { requiresAdmin: true },
  },
  {
    path: '/settings/groups',
    name: 'settings-groups',
    component: () => import('../views/GroupsView.vue'),
    meta: { requiresAdmin: true },
  },
  {
    path: '/settings/groups/:name/edit',
    name: 'settings-groups-edit',
    component: () => import('../views/GroupEditView.vue'),
    props: true,
    meta: { requiresAdmin: true },
  },
  {
    path: '/settings/change-requests',
    name: 'settings-change-requests',
    component: () => import('../views/ChangeRequestsSettingsView.vue'),
    meta: { requiresAdmin: true },
  },

  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('../views/NotFoundView.vue'),
    meta: { public: true },
  },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (!auth.checked) await auth.check();

  if (!to.meta.public && !auth.session) {
    return { name: 'login' };
  }
  if (to.name !== 'no-access' && to.name !== 'account' && auth.session && !auth.hasAccess) {
    return { name: 'no-access' };
  }
  if (to.meta.requiresAdmin && !auth.isAdmin) {
    return { name: 'dashboard' };
  }
  return true;
});
