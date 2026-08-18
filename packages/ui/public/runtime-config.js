// Dev/build-time default: relative API calls (single-domain deployment, proxied — see
// nginx.conf's /api/ location or vite.config.ts's dev server proxy). The production Docker image
// overwrites this file at container start (docker-entrypoint.d script) from the API_ORIGIN env
// var, when the API is deployed on its own separate domain (see charts/a5e's api.origin/
// api.ingress values).
window.__A5E_CONFIG__ = { apiOrigin: '' };
