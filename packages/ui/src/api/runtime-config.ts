export interface RuntimeConfig {
  apiOrigin: string;
}

declare global {
  interface Window {
    __A5E_CONFIG__?: RuntimeConfig;
  }
}

/** Empty string means "same origin as the UI, relative paths" — the default single-domain
 * deployment shape (nginx proxies /api internally, or the Vite dev server does). Only non-empty
 * when the API is deployed on its own separate domain (see charts/a5e's api.origin value),
 * injected into this page at container start — see public/runtime-config.js. */
export function apiOrigin(): string {
  return window.__A5E_CONFIG__?.apiOrigin ?? '';
}
