# Contributing to A5E

Thanks for considering a contribution.

## Development setup

Prerequisites: [Bun](https://bun.sh), a local Kubernetes cluster (development happens against
[OrbStack](https://orbstack.dev)'s built-in cluster, but anything modern should work), and
`kubectl` pointed at it.

```bash
bun install
bun run crds:generate
bun run crds:apply
bun run seed
```

Then run the three services in separate terminals:

```bash
bun run dev:operator
bun run dev:api
bun run dev:ui
```

The UI dev server proxies `/api` to the API's port. If the API's port or the UI's `UI_ORIGIN`
changes, both need to agree (`UI_ORIGIN` drives both CORS and the OIDC redirect URI).

See [Getting started](/guide/getting-started) for more detail on this same workflow.

## Making changes

- **CRD schema changes**: edit the Zod schemas in `packages/schemas/src`, then run
  `bun run crds:generate` and commit both the regenerated `crds/*.yaml` and
  `charts/a5e/templates/crds/*.yaml` alongside your schema change — they're generated from the
  same source and must stay in sync.
- **Adding a new CRD kind**: add it to `packages/schemas/src/crd-meta.ts`'s
  `RESOURCE_DESCRIPTORS`; the API's generic CRUD routes (`resource-routes.ts`) and the UI's
  generic list/form components pick it up from the shared descriptor without per-kind
  boilerplate — only add kind-specific code where the resource genuinely needs a nonstandard
  form or extra routes (see `ansibleruns.ts`/`RunTriggerView.vue` for an example).
- **RBAC changes**: the raw manifests (`crds/rbac/*.yaml`) and the Helm chart
  (`charts/a5e/templates/rbac-*.yaml`) are hand-maintained in parallel, not generated — update
  both.

## Before opening a PR

```bash
bun run lint
bun test
cd packages/<changed-package> && bun run typecheck
```

For UI changes, please also manually verify the change in a browser against a local cluster —
there's no end-to-end test suite yet beyond the manual smoke test described in
[Deployment](/guide/deployment).

## Commit / PR style

- Keep commits focused; explain the *why* in the commit message body when it isn't obvious from
  the diff.
- Open an issue first for anything that changes the CRD API group/kinds, the RBAC model, or the
  auth flow — these are cross-cutting and worth discussing before a large diff.

## Reporting bugs / requesting features

Use [GitHub Issues](https://github.com/LUMASERV/a5e/issues). For security vulnerabilities, see
[Security](/guide/security) instead of filing a public issue.
