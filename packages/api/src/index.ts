import { RESOURCE_DESCRIPTORS } from '@a5e/schemas';
import cors from '@elysiajs/cors';
import { Elysia } from 'elysia';
import { bootstrapAdminAccount } from './auth/bootstrap';
import { migrateLegacyUsersIfNeeded } from './auth/migrate-legacy-users';
import { registerAuthRoutes } from './auth/routes';
import { pruneSupersededOidcIdentities } from './auth/user-store';
import type { AnyElysia } from './lib/elysia-types';
import { registerAncillaryRoutes } from './modules/ancillary';
import { registerAnsibleJobRoutes } from './modules/ansiblejobs';
import { registerAnsibleRunRoutes } from './modules/ansibleruns';
import { registerAppSettingsRoutes } from './modules/app-settings';
import { registerChangeRequestRoutes } from './modules/change-requests';
import { registerInventoryDownloadRoutes } from './modules/inventory-download';
import { registerOidcSettingsRoutes } from './modules/oidc-settings';
import { registerPermissionsSettingsRoutes } from './modules/permissions-settings';
import { registerResourceRoutes } from './modules/resource-routes';
import { registerSSHKeyImportRoutes } from './modules/sshkey-import';
import { registerUsersSettingsRoutes } from './modules/users-settings';

// Migration must run before bootstrap: otherwise a not-yet-migrated deployment with real legacy
// accounts would look "empty" to bootstrapAdminAccount() and get a fresh admin account created
// alongside them, instead of the legacy accounts being carried over as-is.
await migrateLegacyUsersIfNeeded();
await bootstrapAdminAccount();
// After both, so it sees the finished user set — and after bootstrap in particular, since pruning
// must never be what makes the account store look empty. Failing this is not worth refusing to
// serve over: it only tidies up already-inert duplicate rows.
await pruneSupersededOidcIdentities().catch((err) => {
  console.warn(`could not prune duplicate SSO identity records: ${(err as Error).message}`);
});

let app: AnyElysia = new Elysia()
  // `credentials: true` is for the one remaining cookie (oidc_state, auth/routes.ts's CSRF
  // binding for the OIDC login round trip) — the actual session is a bearer token in an
  // Authorization header, which needs `allowedHeaders` to include it explicitly for the
  // preflight the browser sends before any cross-origin request carrying a custom header.
  .use(
    cors({
      credentials: true,
      origin: process.env.UI_ORIGIN ?? 'http://localhost:5173',
      allowedHeaders: ['content-type', 'authorization'],
    }),
  )
  // Without this, any uncaught exception — most commonly the k8s API rejecting an impersonated
  // call with a 403 because the user's real RBAC doesn't cover it — surfaces to the browser as
  // an opaque 500 "Internal Server Error" instead of the actual status/message. client-node's
  // errors carry the real HTTP status as a numeric `.code`; Elysia's own internal error taxonomy
  // uses string codes (NOT_FOUND, VALIDATION, ...), so checking `typeof code === 'number'"`
  // cleanly tells the two apart.
  .onError(({ error, set }) => {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number' && code >= 400 && code < 600) {
      set.status = code;
      return { error: (error as Error).message || 'request failed' };
    }
    console.error(error);
    set.status = 500;
    return { error: 'internal error' };
  });

app = registerAuthRoutes(app);
app = registerAncillaryRoutes(app);
app = registerOidcSettingsRoutes(app);
app = registerUsersSettingsRoutes(app);
app = registerPermissionsSettingsRoutes(app);
app = registerAppSettingsRoutes(app);
app = registerSSHKeyImportRoutes(app); // before the generic routes: same base paths + a literal "import" segment
app = registerInventoryDownloadRoutes(app); // same base paths + a literal "download" segment
for (const descriptor of RESOURCE_DESCRIPTORS) {
  if (descriptor.kind === 'ChangeRequest') continue; // registered below with bespoke create/delete
  if (descriptor.kind === 'Group') continue; // fully custom, admin-only routes — see permissions-settings.ts
  if (descriptor.kind === 'User') continue; // fully custom, admin-only routes — see users-settings.ts
  app = registerResourceRoutes(app, descriptor);
}
app = registerChangeRequestRoutes(app);
app = registerAnsibleRunRoutes(app);
app = registerAnsibleJobRoutes(app);

const port = Number(process.env.PORT ?? 3000);
app.listen(port);
console.log(`api listening on :${port}`);
