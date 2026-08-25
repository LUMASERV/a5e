# a5e

Helm chart for A5E, a Kubernetes-native Ansible Semaphore alternative: deploys the operator, the
API (OIDC BFF + in-app-permission-gated CRUD/watch relay), the UI, the 13 `a5e.k8s.rocks` CRDs, and
the RBAC each component needs.

## Install

```bash
helm install a5e charts/a5e \
  --namespace a5e-system --create-namespace \
  --set image.registry=registry.lumaserv.dev/public/a5e \
  --set image.tag=0.2.0 \
  --set api.uiOrigin=https://a5e.example.com \
  --set api.bootstrapAdmin.username=admin \
  --set api.bootstrapAdmin.password=change-me \
  --set ui.ingress.enabled=true \
  --set ui.ingress.className=nginx \
  --set ui.ingress.hosts[0].host=a5e.example.com
```

`api.bootstrapAdmin` creates exactly one local admin account the very first time no local account
exists yet — otherwise there's no way to log in at all to configure anything else. It's safe to
leave set; rotate/remove that password via Settings → Users afterward instead of relying on it
again.

OIDC is configured from the Settings page after install (issuer/clientId/clientSecret, stored in
a Secret the API manages itself), not chart values — the redirect URI to register at your IdP is
shown there too. `api.oidc.create=true` (+ issuer/clientId/clientSecret) or
`api.oidc.existingSecret` only seed a bootstrap default. See `values.yaml` for every option.

## Running the API and UI on separate domains

By default the UI serves the API too, via its own nginx reverse-proxying `/api` to the API
Service internally (see `packages/ui/nginx.conf`) — one Ingress, one domain, and auth is a bearer
token the UI stores and attaches itself (not a cookie, so this works regardless of same- or
cross-origin). To split them onto separate domains instead:

```bash
helm upgrade --install a5e charts/a5e \
  --set api.uiOrigin=https://a5e.example.com \
  --set api.origin=https://a5e-api.example.com \
  --set ui.ingress.enabled=true \
  --set ui.ingress.hosts[0].host=a5e.example.com \
  --set api.ingress.enabled=true \
  --set api.ingress.hosts[0].host=a5e-api.example.com
```

Setting `api.origin` does two things: the OIDC redirect_uri is derived from it instead of
`api.uiOrigin` (the callback route lives on the API, wherever that is), and it's injected into
the UI container at start (see the image's `docker-entrypoint.d` script) so the browser calls the
API's domain directly instead of the relative `/api` path.

`api.ingress` is the same shape as `ui.ingress` — `annotations`/`tls` are plain pass-through, so
cert-manager (a `cert-manager.io/cluster-issuer` annotation + a `tls` entry) and haproxy-ingress
source-IP allowlisting (`haproxy-ingress.github.io/whitelist-source-range`) work exactly as they
would on any other Ingress, nothing chart-specific to configure.

## Notes

- **CRDs are regular templates, not Helm's special `crds/` directory** — `helm upgrade` applies
  schema changes, which matters because these CRDs change often during active development. This
  trades away Helm's default CRD-safety net, so every CRD carries `helm.sh/resource-policy: keep`
  (toggle via `crds.keep`) so `helm uninstall` doesn't delete them — and with them, every
  AnsibleHost/AnsibleRun/etc. custom resource in the cluster.
- CRD manifests here are generated, not hand-written — see
  `packages/schemas/gen/crd-yaml.ts`, which writes both `crds/*.yaml` (the raw/kustomize path used
  for local OrbStack dev) and `charts/a5e/templates/crds/*.yaml` (this chart) from the same
  Zod schemas. Run `bun run generate` in `packages/schemas` after any schema change and commit
  both outputs together.
- There's no dev-mode auth bypass — every login is a real OIDC round-trip or a real local
  account (a `User` CRD plus a password hash in a narrowly-scoped Secret — see
  `packages/api/src/auth/user-store.ts`/`user-passwords.ts`); `api.bootstrapAdmin` is how the
  first one gets created.
- The API Deployment runs a single replica by design — its session store is in-memory
  (`auth/session-store.ts`); don't raise `api.replicaCount` without moving sessions to a shared
  store first.
- Authorization is entirely in-app, not Kubernetes RBAC: the API acts as its own identity
  (`a5e-api`'s ServiceAccount) for every Kubernetes call and decides allow/deny itself via each
  user's/`Group`'s `Permission` grants (`auth/permission-engine.ts`) — a user who logs in
  successfully but has no grants (and isn't `role: admin`, which bypasses this entirely) will see
  everything 403 until an admin grants them permissions directly or via a `Group`, in Settings.
