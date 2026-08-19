# Architecture

A5E has four pieces, all in this monorepo:

## Operator (`packages/operator`)

Reconciles the CRDs against the outside world:

- Renders each `AnsibleInventory`'s resolved host list into an INI/YAML inventory.
- Resolves an `AnsiblePlaybook`'s source — inline text, a `ConfigMap` reference, or a git
  repository.
- Runs each `AnsibleRun` as a Kubernetes `Job`, using the [runner image](https://github.com/LUMASERV/a5e/tree/main/packages/runner-image)
  (Ansible + the resolved inventory/playbook mounted in).
- Ticks `AnsibleJob`'s cron schedule and spawns new `AnsibleRun`s for it.

The operator authenticates to the Kubernetes API as its own ServiceAccount — it never
impersonates anyone. Every reconcile loop is a pure function from "current spec + current
external state" to "desired status/child objects," which is what makes the namespace-scoping
rules in [Custom resources](/guide/crds) enforceable in one place
(`packages/k8s-client/src/ref-namespace.ts`).

## API (`packages/api`)

A thin [Elysia](https://elysiajs.com) backend with two jobs:

1. **Authentication** — OIDC (Authorization Code + PKCE) or local username/password accounts. See
   [Authentication](/guide/authentication) for the full model, including why sessions are a
   bearer token rather than a cookie.
2. **Authorization relay** — every CRUD/watch call is impersonated as the logged-in user via
   Kubernetes' `Impersonate-User`/`Impersonate-Group` headers, so **real Kubernetes RBAC is the
   actual source of truth**, not application code. The API's own ServiceAccount holds no direct
   CRUD permissions on the CRDs at all.

Routes are generated from the same per-kind resource descriptor the UI uses
(`packages/schemas/src/crd-meta.ts`), so adding a new CRD kind doesn't mean hand-writing seven
routes for it.

## UI (`packages/ui`)

Vue 3 + [Element Plus](https://element-plus.org), also driven by the shared resource descriptor —
list/form/detail views are generic components parameterized per kind, not nine near-duplicate
screens. Talks to the API only through `fetch()` with a bearer token; there's no server-rendered
page and no cookie anywhere in the stack.

## CRDs (`packages/schemas`)

[Zod](https://zod.dev) schemas are the single source of truth for every CRD's shape. A generator
(`packages/schemas/gen/crd-yaml.ts`) turns them into:

- `crds/*.yaml` — plain manifests for `kubectl apply -k crds/` (local dev, no Helm)
- `charts/a5e/templates/crds/*.yaml` — the same CRDs as Helm chart templates

Both are committed and must be regenerated together after any schema change (`bun run
crds:generate`) — CI checks they haven't drifted.

## Data flow for a run

```
you (browser) → UI → API (impersonated) → Kubernetes API → AnsibleRun object
                                                                    │
                                              operator watches ← ───┘
                                                    │
                                        renders inventory + playbook,
                                        creates a Job
                                                    │
                                            Job runs ansible-playbook
                                                    │
                                     operator streams status/logs back
                                                    │
                        UI ← API (impersonated, live SSE) ← Kubernetes API (pod logs)
```

Live updates (resource lists, run logs) are Server-Sent Events relayed from a real Kubernetes
`watch`/pod-log stream — not polling.
