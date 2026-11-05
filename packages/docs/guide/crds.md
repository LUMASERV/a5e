# Custom resources

All ten kinds live under the API group `a5e.k8s.rocks/v1alpha1`. Five have a namespaced and a
`Cluster`-scoped variant, mirroring cert-manager's `Issuer`/`ClusterIssuer` pattern — namespaced
for per-team resources, cluster-scoped for ones meant to be shared across namespaces.

| Namespaced | Cluster-scoped | Purpose |
|---|---|---|
| `AnsibleHost` | `ClusterAnsibleHost` | One target machine — its connection address, port, user, optional SSH jump host, the `AnsibleSSHKey` it connects with, and its host vars (inline or [from a Secret/ConfigMap](#host-vars-from-a-secret-or-configmap)). |
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

## Host vars from a Secret or ConfigMap

Alongside inline `spec.vars`, a host can pull vars from Secrets and ConfigMaps. The shape is a
container's `envFrom`: a list where each entry names exactly one source.

```yaml
apiVersion: a5e.k8s.rocks/v1alpha1
kind: AnsibleHost
metadata:
  name: db-01
  namespace: team-a
spec:
  ansibleAddress: 10.0.0.11
  sshKeyRef: { kind: AnsibleSSHKey, name: team-a-key }
  varsFrom:
    - configMapRef:
        name: db-tuning          # namespace optional — defaults to the host's own
    - secretRef:
        name: db-01-credentials
  vars:
    role: primary
```

Every key in each referenced object becomes a host var of the same name. Entries apply in array
order (a later one overrides an earlier one), and an inline `spec.vars` entry always beats a
sourced var of the same name. Exactly one of `secretRef`/`configMapRef` per entry, enforced by CEL
in the CRD.

On `ClusterAnsibleHost` the `namespace` field is **required** — a cluster-scoped object has no
namespace of its own to default to. On the namespaced `AnsibleHost` it is optional and, if given,
must be the host's own namespace (the [scoping rule](#namespace-scoping-rules) above).

Unlike `envFrom` there is no `prefix` and no `optional`: a missing source fails the Run rather than
being skipped. Both are cheap to add if someone wants them.

Three things follow from a source possibly being a real secret:

- **Referencing one needs its own permission.** The operator dereferences `varsFrom` with its own
  cluster-wide-privileged identity, so the API gates *who may point a host at an object*: the `use`
  action on the built-in `Secret` and `ConfigMap` permission types, scoped by namespace (see
  [Authentication](/guide/authentication)). A ConfigMap is gated for the same reason a Secret is —
  it is someone else's data either way. Approving a change request that adds one is checked the
  same way, against the approver.
- **No value is ever written into the rendered inventory.** For each distinct source referenced by
  some host in a run, the operator copies it into a run-owned object of the same kind and mounts it
  in the Job at `/host-vars/<mount>/`, one file per key. The inventory ConfigMap then references
  those files rather than the values:

  ```ini
  db-01 ansible_host=10.0.0.11 db_password="{{ lookup('file', '/host-vars/vars-1f3c2ab9d4/db_password', rstrip=False) }}"
  ```

  So the inventory stays an ordinary ConfigMap you can read and diff while debugging, and a
  Secret's values exist only as a byte-for-byte copy of the Secret. (The copy is unavoidable — a
  volume can only mount an object in the Pod's own namespace, and a `ClusterAnsibleInventory` can
  pull in a host, and its Secret, from elsewhere. It's the same copy `AnsibleSSHKey` already gets.)

  The mount name is a hash of the source's kind, namespace, name and contents. That keeps it stable
  across the repeated resolves a parallel run does as it refills shards, and means editing the
  source mid-run produces a *new* mount rather than overwriting the one an already running Job has
  mounted — so each shard keeps a consistent snapshot.

  This is also more correct than inlining would be: Ansible templates inventory var values, so a
  literal value that happens to contain Jinja delimiters would fail the play outright, whereas a
  lookup's *result* is not re-templated — any byte sequence round-trips intact. `rstrip=False`
  stops the file lookup from trimming a trailing newline it would otherwise drop by default.
- **Secret values are masked wherever they'd be shown back.** The resolved-inventory download lists
  which vars each source contributes but replaces each Secret-derived value longer than
  `SECRET_VALUE_MASK_MIN_LENGTH` (5) characters with `********`. A downloaded inventory therefore
  needs those vars supplied another way before `ansible-playbook -i` will work with it. ConfigMap
  values are shown as-is — a ConfigMap is not a credential store, and masking it would defeat the
  point of offering it as a source.

  Note the threshold cuts both ways: a Secret value of **5 characters or fewer is shown verbatim**.
  A mask is a blanket substitution, and a 1–5 character value ("yes", "22", a single digit) collides
  with unrelated text everywhere it appears — masking those would shred legitimate output to protect
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
