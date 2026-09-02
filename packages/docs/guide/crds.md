# Custom resources

All ten kinds live under the API group `a5e.k8s.rocks/v1alpha1`. Five have a namespaced and a
`Cluster`-scoped variant, mirroring cert-manager's `Issuer`/`ClusterIssuer` pattern — namespaced
for per-team resources, cluster-scoped for ones meant to be shared across namespaces.

| Namespaced | Cluster-scoped | Purpose |
|---|---|---|
| `AnsibleHost` | `ClusterAnsibleHost` | One target machine — its connection address, port, user, optional SSH jump host, the `AnsibleSSHKey` it connects with, and its host vars (inline or [from a `Secret`](#host-vars-from-a-secret)). |
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

## Host vars from a Secret

Alongside inline `spec.vars`, a host can pull vars out of one or more `v1/Secret`s:

```yaml
apiVersion: a5e.k8s.rocks/v1alpha1
kind: AnsibleHost
metadata:
  name: db-01
  namespace: team-a
spec:
  ansibleAddress: 10.0.0.11
  sshKeyRef: { kind: AnsibleSSHKey, name: team-a-key }
  varsBySecretRef:
    - name: db-01-credentials     # namespace optional — defaults to the host's own
  vars:
    role: primary
```

Every key in each referenced Secret becomes a host var of the same name. Entries apply in array
order (a later one overrides an earlier one), and an inline `spec.vars` entry always beats a
Secret-sourced var of the same name.

On `ClusterAnsibleHost` the `namespace` field is **required** — a cluster-scoped object has no
namespace of its own to default to. On the namespaced `AnsibleHost` it is optional and, if given,
must be the host's own namespace (the [scoping rule](#namespace-scoping-rules) above).

Three things follow from these values being real secrets:

- **Referencing a Secret needs its own permission.** The operator dereferences `varsBySecretRef` with
  its own cluster-wide-privileged identity, so the API gates *who may point a host at a Secret*:
  the `use` action on the built-in `Secret` permission type, scoped by namespace (see
  [Authentication](/guide/authentication)). Approving a change request that adds one is checked
  the same way, against the approver.
- **No value is ever written into the rendered inventory.** For each distinct Secret referenced by
  some host in a run, the operator copies it into a run-owned Secret and mounts it in the Job at
  `/host-vars/<mount>/`, one file per key. The inventory ConfigMap then references those files
  rather than the values:

  ```ini
  db-01 ansible_host=10.0.0.11 db_password="{{ lookup('file', '/host-vars/vars0/db_password', rstrip=False) }}"
  ```

  So the inventory stays an ordinary ConfigMap you can read and diff while debugging, and the
  values exist only as a byte-for-byte copy of the Secret. (The copy is unavoidable — a Secret
  volume can only mount a Secret in the Pod's own namespace, and a `ClusterAnsibleInventory` can
  pull in a host, and its Secret, from elsewhere. It's the same copy `AnsibleSSHKey` already gets.)

  This is also more correct than inlining would be: Ansible templates inventory var values, so a
  literal value that happens to contain Jinja delimiters would fail the play outright, whereas a
  lookup's *result* is not re-templated — any byte sequence round-trips intact. `rstrip=False`
  stops the file lookup from trimming a trailing newline it would otherwise drop by default.
- **Values are masked wherever they'd be shown back.** The resolved-inventory download lists which
  vars a Secret contributes but replaces each value longer than
  `SECRET_VALUE_MASK_MIN_LENGTH` (5) characters with `********`. A downloaded inventory therefore
  needs those vars supplied another way before `ansible-playbook -i` will work with it.

  Note the threshold cuts both ways: a value of **5 characters or fewer is shown verbatim**. A mask
  is a blanket substitution, and a 1–5 character value ("yes", "22", a single digit) collides with
  unrelated text everywhere it appears — masking those would shred legitimate output to protect
  something guessable in a handful of tries. Don't treat the download as safe for an audience that
  shouldn't see very short secret values.

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
