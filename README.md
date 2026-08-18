# A5E

A Kubernetes-native alternative to Ansible Semaphore/AWX. Hosts, inventories, playbooks, SSH
keys, scheduled jobs, and playbook runs are all modeled as Kubernetes Custom Resources
(`a5e.k8s.rocks`), reconciled by an operator, exposed through a thin API, and managed from a
Vue-based UI. "A5E" is a numeronym for "Ansible" (A + 5 letters + E), the same pattern as
"k8s"/"i18n".

## Architecture

- **Operator** (`packages/operator`) — reconciles the CRDs: renders inventories, resolves
  playbook sources (inline / ConfigMap / git), and runs each `AnsibleRun` as a Kubernetes Job.
- **API** (`packages/api`) — a thin Elysia backend. Authenticates users via OIDC (Authorization
  Code + PKCE, exchanged server-side so the browser never sees an IdP token) or local
  username/password accounts; either way, the API hands back its own opaque bearer token for the
  UI to store and attach as `Authorization: Bearer` on every call — not a cookie, so the UI and
  API can be deployed on independent origins/domains (see `charts/a5e`'s separate
  `ui.ingress`/`api.ingress`). Every call then relays to the Kubernetes API **impersonating the
  logged-in user**, so real Kubernetes RBAC is the actual source of authorization truth.
- **UI** (`packages/ui`) — Vue 3 + Element Plus, generic list/form components driven by a shared
  per-kind resource descriptor so the 10 CRD kinds don't need hand-duplicated CRUD screens.
- **CRDs** (`packages/schemas`) — Zod schemas are the single source of truth, generating both the
  raw `crds/*.yaml` (kustomize) and `charts/a5e/templates/crds/*.yaml` (Helm) manifests.

Every `Cluster*`-scoped kind (`AnsibleHost`/`ClusterAnsibleHost`, etc.) mirrors cert-manager's
`Issuer`/`ClusterIssuer` pattern — namespaced for per-team resources, cluster-scoped for shared
ones.

## Quickstart (local dev)

Prerequisites: [Bun](https://bun.sh), a local Kubernetes cluster (this project develops against
[OrbStack](https://orbstack.dev)'s built-in cluster), and `kubectl` pointed at it.

```bash
bun install
bun run crds:generate   # regenerate crds/*.yaml + charts/a5e/templates/crds/*.yaml from packages/schemas
bun run crds:apply      # kubectl apply -k crds/
bun run seed            # sample AnsibleHost/AnsibleInventory/AnsiblePlaybook/AnsibleSSHKey + a dev ServiceAccount token
```

`bun run seed` prints the env vars it needs and the `BOOTSTRAP_ADMIN_USERNAME`/
`BOOTSTRAP_ADMIN_PASSWORD` to set for your first login, then:

```bash
bun run dev:operator
bun run dev:api
bun run dev:ui
```

## Deploying

See [`charts/a5e/README.md`](charts/a5e/README.md) for the Helm chart.

## Development

```bash
bun run lint        # biome check
bun run format      # biome format --write
bun test            # per package
```

Each package also has its own `typecheck` script (`bun run --filter '*' typecheck` from the
root, or `cd packages/<name> && bun run typecheck`).

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full contribution workflow.

## License

[Apache 2.0](LICENSE). See [`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md) for runtime
dependency licenses.
