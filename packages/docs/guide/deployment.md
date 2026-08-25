# Deployment

A5E ships as a single Helm chart (`charts/a5e`) that installs the operator, the API, the UI, the
10 CRDs, and the RBAC each component needs.

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
exists yet (see [Authentication](/guide/authentication#bootstrap)) — safe to leave set;
rotate/remove the password via Settings → Users afterward.

OIDC is configured from the Settings page after install, not chart values — the redirect URI to
register at your IdP is shown there too. `api.oidc.create=true` (+ issuer/clientId/clientSecret)
or `api.oidc.existingSecret` only seed a bootstrap default. See `values.yaml` for every option.

## Running the API and UI on separate domains

By default the UI serves the API too, via its own nginx reverse-proxying `/api` to the API
Service internally — one Ingress, one domain. Because sessions are a bearer token, not a cookie
(see [Authentication](/guide/authentication#sessions-are-a-bearer-token-not-a-cookie)), this
works the same whether they're same-origin or not — so you can split them onto separate domains
instead:

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
the UI container at start so the browser calls the API's domain directly instead of the relative
`/api` path.

## cert-manager and ingress allowlisting

`ui.ingress` and `api.ingress` are both plain-pass-through shapes — `annotations`/`tls` land on
the `Ingress` object exactly as given, so this all works with no chart-specific configuration:

```bash
helm upgrade --install a5e charts/a5e \
  --set ui.ingress.enabled=true \
  --set ui.ingress.hosts[0].host=a5e.example.com \
  --set 'ui.ingress.annotations.cert-manager\.io/cluster-issuer'=letsencrypt \
  --set 'ui.ingress.annotations.haproxy-ingress\.github\.io/whitelist-source-range'=10.0.0.0/8 \
  --set 'ui.ingress.tls[0].secretName'=a5e-tls \
  --set 'ui.ingress.tls[0].hosts[0]'=a5e.example.com
```

`api.ingress` accepts the identical shape.

## Notes

- **CRDs are regular templates, not Helm's special `crds/` directory** — `helm upgrade` applies
  schema changes, which matters because these CRDs change often during active development. This
  trades away Helm's default CRD-safety net, so every CRD carries `helm.sh/resource-policy: keep`
  (toggle via `crds.keep`) so `helm uninstall` doesn't delete them — and with them, every
  `AnsibleHost`/`AnsibleRun`/etc. custom resource in the cluster.
- There's no dev-mode auth bypass — every login is a real OIDC round-trip or a real local
  account; `api.bootstrapAdmin` is how the first one gets created.
- The API Deployment runs a single replica by design — its session store is in-memory; don't
  raise `api.replicaCount` without moving sessions to a shared store first.
- Actual authorization is real Kubernetes RBAC: after install, map your OIDC group claims to
  RoleBindings/ClusterRoleBindings on the CRDs yourself — a user who logs in successfully but has
  no bindings will see everything 403 (see [Authentication](/guide/authentication)).

See [`charts/a5e/README.md`](https://github.com/LUMASERV/a5e/blob/main/charts/a5e/README.md) and
`values.yaml` in the repo for the exhaustive option list.
