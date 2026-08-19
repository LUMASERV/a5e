# Getting started

A5E has three runtime components — an **operator**, an **API**, and a **UI** — plus a set of
[Custom Resource Definitions](/guide/crds) they all share. This page covers running them locally
against a development cluster. For a real deployment, see [Deployment](/guide/deployment).

## Prerequisites

- [Bun](https://bun.sh)
- A local Kubernetes cluster — development happens against [OrbStack](https://orbstack.dev)'s
  built-in cluster, but anything modern works
- `kubectl` pointed at that cluster

## Install and seed

```bash
bun install
bun run crds:generate   # regenerate crds/*.yaml + charts/a5e/templates/crds/*.yaml from packages/schemas
bun run crds:apply      # kubectl apply -k crds/
bun run seed            # sample AnsibleHost/AnsibleInventory/AnsiblePlaybook/AnsibleSSHKey + a dev ServiceAccount token
```

`bun run seed` prints the environment variables it needs, plus the `BOOTSTRAP_ADMIN_USERNAME`/
`BOOTSTRAP_ADMIN_PASSWORD` to set for your very first login (see
[Authentication](/guide/authentication) for how that bootstrap account works).

## Run the three services

In separate terminals:

```bash
bun run dev:operator
bun run dev:api
bun run dev:ui
```

The UI dev server proxies `/api` to the API's port automatically. Open the printed local URL and
sign in with the bootstrap admin account.

## Everyday development

```bash
bun run lint        # biome check
bun run format      # biome format --write
bun test            # per package
```

Each package also has its own `typecheck` script — `bun run --filter '*' typecheck` from the
root, or `cd packages/<name> && bun run typecheck`.

See [Contributing](/contributing) for the full workflow, including what to update together when
you change a CRD schema or an RBAC rule.
