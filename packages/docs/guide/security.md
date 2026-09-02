# Security

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities. Use
[GitHub Security Advisories](https://github.com/LUMASERV/a5e/security/advisories/new) instead —
see [`SECURITY.md`](https://github.com/LUMASERV/a5e/blob/main/SECURITY.md) in the repo for what
to include.

## The authorization model, in one paragraph

Every Kubernetes API call the API makes on a user's behalf goes out impersonated as that user
(`Impersonate-User`/`Impersonate-Group` headers), never as the API's own ServiceAccount. That
means **real Kubernetes RBAC is the actual, final authorization boundary** — the app-level
`none`/`user`/`admin` role (see [Authentication](/guide/authentication)) is a coarse UX gate on
top of it, not a substitute for it. A cluster admin who wants to restrict what a team can do
should do it with `RoleBinding`s on the CRDs, the same way they'd restrict anything else in the
cluster.

## Namespace isolation

Every ref field between namespaced objects (an `AnsibleRun`'s `playbookRef`, an `AnsibleHost`'s
`sshKeyRef`, and so on) is restricted to the referencing object's own namespace — see
[Custom resources](/guide/crds#namespace-scoping-rules). This matters specifically because the
operator resolves those refs with its own cluster-wide-privileged identity, not the requesting
user's; without the restriction, a user with only namespace-local create permissions could
otherwise read another namespace's Secrets by pointing a ref at them.

## Things worth knowing before you deploy

- **Sessions are a bearer token, not a cookie** — deliberately, so the UI and API can run on
  independent origins. See [Authentication](/guide/authentication#sessions-are-a-bearer-token-not-a-cookie)
  for the trade-off this makes and why it's acceptable given the RBAC model above.
- **The operator's ServiceAccount can read any Secret in the cluster** — it needs to, to
  reconcile `AnsibleSSHKey`/git-auth/[`varsBySecretRef`](/guide/crds#host-vars-from-a-secret)
  references that can live in any namespace. This is a documented, accepted trade-off (see
  `crds/rbac/operator.yaml`'s own comments), not an oversight. The API's own ServiceAccount also
  holds cluster-wide `get` on Secrets, for the single path that needs it: listing which host vars
  a `varsBySecretRef` entry contributes for the resolved-inventory download, where every value is
  masked before it leaves the process.
- **Pointing a host at a Secret is its own permission** — the `use` action on the built-in
  `Secret` type, namespace-scoped. Without it, anyone who could create an `AnsibleHost` could have
  the operator read any Secret the namespace rule allows and render it into a run. Note that this
  is an API-level gate: a user with direct `kubectl` access to create `AnsibleHost` objects
  bypasses it, exactly as they bypass every other grant in the permission engine.
- **The API deployment runs a single replica by design** — its session store is in-memory. Don't
  scale it without moving sessions to a shared store first.
- **There's no dev-mode auth bypass** anywhere in the codebase — every login is a real OIDC
  round-trip or a real local account, in every environment.
