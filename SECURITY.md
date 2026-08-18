# Security Policy

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, use [GitHub Security Advisories](https://github.com/LUMASERV/a5e/security/advisories/new)
to report privately. Include:

- A description of the vulnerability and its potential impact.
- Steps to reproduce, or a proof of concept if available.
- The affected version/commit.

We'll acknowledge your report as soon as possible and work with you on a fix and coordinated
disclosure timeline.

## Scope

A5E's authorization model relies on real Kubernetes RBAC (the API impersonates the logged-in
user for every Kubernetes API call — see `packages/api/src/plugins/k8s.ts` and
`packages/k8s-client/src/customResourceClient.ts`). Reports involving privilege escalation past a
user's actual RBAC grants, session/auth handling (`packages/api/src/auth/`), or secret handling
(OIDC client secret, local account password hashing, SSH key storage) are especially welcome.
