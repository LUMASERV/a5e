# Custom resources

All ten kinds live under the API group `a5e.k8s.rocks/v1alpha1`. Five have a namespaced and a
`Cluster`-scoped variant, mirroring cert-manager's `Issuer`/`ClusterIssuer` pattern — namespaced
for per-team resources, cluster-scoped for ones meant to be shared across namespaces.

| Namespaced | Cluster-scoped | Purpose |
|---|---|---|
| `AnsibleHost` | `ClusterAnsibleHost` | One target machine — its connection address, port, user, optional SSH jump host, and the `AnsibleSSHKey` it connects with. |
| `AnsibleInventory` | `ClusterAnsibleInventory` | A named set of host groups, each populated by a label selector over `AnsibleHost`/`ClusterAnsibleHost` objects. |
| `AnsiblePlaybook` | `ClusterAnsiblePlaybook` | A playbook source — inline text, a `ConfigMap` reference, or a git repository — plus optional Galaxy role/collection dependencies. |
| `AnsibleSSHKey` | `ClusterAnsibleSSHKey` | A reference to a `Secret` holding an SSH private key (and optional passphrase), used by hosts to connect. |
| `AnsibleRun` | — (namespaced only) | One execution of a playbook against an inventory — spawns a Kubernetes `Job`, tracks phase/logs/exit code. |
| `AnsibleJob` | — (namespaced only) | A cron-scheduled template for `AnsibleRun`s, with configurable history retention. |

## Namespace scoping rules

A namespaced object may only reference other namespaced objects in **its own namespace** — an
`AnsibleRun` in `team-a` cannot point its `playbookRef`/`inventoryRef` at an `AnsiblePlaybook` in
`team-b`, an `AnsibleHost` cannot borrow another namespace's `AnsibleSSHKey`, and so on. A
`Cluster*`-scoped object has no "home" namespace, so its refs may (and for namespaced targets,
must) name one explicitly.

This is enforced centrally in `packages/k8s-client/src/ref-namespace.ts` and used by every
resolver in the operator — it's the mechanism that keeps one team's Secrets from being reachable
by another team's objects even though the operator itself runs with cluster-wide read access.

## Status conventions

Every kind's `status` includes `observedGeneration` and a `conditions` list (the standard
Kubernetes condition shape: `type`, `status`, `reason`, `message`, `lastTransitionTime`). An
`AnsibleRun`'s `status.phase` moves through `Pending → Resolving → Running → Succeeded | Failed |
Error | Cancelled`; `Error` means the operator itself couldn't resolve refs or create the Job,
while `Failed` means `ansible-playbook` ran and exited non-zero.

## Generating the CRDs

Schemas live in `packages/schemas/src/*.ts` as [Zod](https://zod.dev) objects. Run:

```bash
bun run crds:generate
```

from the repo root to regenerate both `crds/*.yaml` and `charts/a5e/templates/crds/*.yaml` from
them — always commit both outputs together, CI checks they match.
