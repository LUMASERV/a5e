import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'A5E',
  description: 'A Kubernetes-native alternative to Ansible Semaphore/AWX',
  // Served from the custom domain's root (a5e.k8s.rocks) — see public/CNAME — so no subpath base.
  base: '/',
  cleanUrls: true,
  head: [['link', { rel: 'icon', href: '/favicon.svg' }]],

  themeConfig: {
    logo: '/favicon.svg',
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Deployment', link: '/guide/deployment' },
      { text: 'Contributing', link: '/contributing' },
      { text: 'GitHub', link: 'https://github.com/LUMASERV/a5e' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'Architecture', link: '/guide/architecture' },
          { text: 'Custom resources', link: '/guide/crds' },
          { text: 'Authentication', link: '/guide/authentication' },
          { text: 'Deployment', link: '/guide/deployment' },
          { text: 'Security', link: '/guide/security' },
        ],
      },
      {
        text: 'Project',
        items: [
          { text: 'Contributing', link: '/contributing' },
          { text: 'Code of Conduct', link: '/code-of-conduct' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/LUMASERV/a5e' }],
    editLink: {
      pattern: 'https://github.com/LUMASERV/a5e/edit/main/packages/docs/:path',
    },
    search: { provider: 'local' },
    footer: {
      message: 'Released under the Apache 2.0 License.',
      copyright: 'Copyright © 2026 LUMASERV Group',
    },
  },
});
