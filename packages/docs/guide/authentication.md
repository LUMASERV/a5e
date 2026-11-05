# Authentication

## Two ways to sign in

- **OIDC** — Authorization Code + PKCE, exchanged server-side by the API so the browser never
  sees an identity-provider token. Configured live from Settings → OIDC login (issuer, client ID,
  client secret, scopes), stored in a Secret the API manages itself — not a redeploy.
- **Local accounts** — username/password, hashed with `Bun.password` (argon2id). This is how the
  very first admin identity gets bootstrapped, and remains available as a fallback independent of
  whatever IdP is configured.

If a local account's email matches an OIDC login's **verified** email, that OIDC identity gets
linked to the local account automatically — from then on, either login method resolves to the
same Kubernetes impersonation identity and app role, and the two show up as a single row in
Settings → Users. Linking only happens with an IdP-asserted `email_verified` claim (the boolean
`true`, or the string `"true"` some IdPs emit instead), specifically so an unverified email on a
permissive IdP can't be used to hijack an existing account.

Linking also needs the **`email` scope**, which the default `openid profile` doesn't include —
without it the token carries no `email` claim for linking to match on, so an SSO login that
*should* have linked instead creates its own separate identity and the same person ends up listed
twice under one email address. Add `email` in Settings → OIDC login (it isn't on by default
because an IdP has to define that scope explicitly, and requesting an undefined one fails the
login outright with `invalid_scope`).

An SSO identity that matches no local account is recorded on its first login with app role
`none`, so an admin has something to find and promote. It gets a **username derived from the
IdP's claims** — `preferred_username`, else the local part of the email, else the raw `sub`,
de-duplicated with a `-2`, `-3`, … suffix if another identity already holds it. That username is
only a label until the identity is promoted (Settings → Users → Edit, which pre-fills it): a
pure-SSO identity's Kubernetes impersonation identity stays its raw OIDC `sub`, and it has no
password login. Promoting it turns it into a real local account, at which point the impersonation
identity becomes `local:<username>` — so re-check any RoleBindings you bound to the `sub`.

## Bootstrap

On first startup, if the local-accounts store is completely empty and
`BOOTSTRAP_ADMIN_USERNAME`/`BOOTSTRAP_ADMIN_PASSWORD` are set, the API creates exactly one local
admin account — the on-ramp for a fresh install, since nobody can reach Settings to configure
OIDC or create further accounts without logging in at least once. It never touches an existing
account, so it's safe to leave those environment variables set indefinitely; rotate the password
via Settings → Users afterward instead of relying on it again.

## Sessions are a bearer token, not a cookie

The API hands back an opaque token on successful login, which the UI stores (in `localStorage`)
and attaches as `Authorization: Bearer <token>` on every request — deliberately not a cookie.
This is what lets the UI and API be deployed on **independent origins or domains** (see
[Deployment](/guide/deployment#running-the-api-and-ui-on-separate-domains)) without a
cross-origin cookie needing `SameSite=None` — which would need Origin-header validation on every
mutating route to keep the CSRF protection that `SameSite` normally provides for free.

The trade-off, made deliberately: a bearer token in `localStorage` is readable by any JS running
on the page, including an XSS payload — the classic downside of token-based SPA auth versus an
`httpOnly` cookie. Real Kubernetes RBAC via impersonation is what limits the actual blast radius
of a stolen token to whatever that specific user's own RBAC bindings allow.

The one remaining cookie in the whole system is `oidc_state` — a short-lived, `httpOnly` cookie
that binds the OAuth `state` parameter to the browser that started the login, entirely within the
`/login → /callback` round trip on the API's own origin. It has nothing to do with the session
model above.

## App role vs. Kubernetes RBAC — two different gates

A fresh identity (local or OIDC) starts with app role `none`: it can log in and see its own
identity, and nothing else. An admin promotes it to `user` (can use the app) or `admin` (can
additionally reach Settings) from **Settings → Users**, which lists every local account and every
OIDC identity that's ever logged in.

This app role is a coarse, fast-to-check gate that exists purely so a fresh login doesn't
immediately hit a wall of raw Kubernetes 403s. **It is not the authorization model** — actual
access to hosts, inventories, playbooks, runs, etc. is real Kubernetes RBAC, evaluated against
the impersonated identity on every single call. A user with app role `user` but no RBAC
bindings will see everything 403; map your OIDC group claims (or a local account's
`impersonateGroups`) to RoleBindings/ClusterRoleBindings yourself after granting the app role.
