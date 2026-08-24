import { RESOURCE_DESCRIPTORS } from '@a5e/schemas';
import cors from '@elysiajs/cors';
import { Elysia } from 'elysia';
import { bootstrapAdminAccount } from './auth/bootstrap';
import { registerAuthRoutes } from './auth/routes';
import type { AnyElysia } from './lib/elysia-types';
import { registerAncillaryRoutes } from './modules/ancillary';
import { registerAnsibleJobRoutes } from './modules/ansiblejobs';
import { registerAnsibleRunRoutes } from './modules/ansibleruns';
import { registerInventoryDownloadRoutes } from './modules/inventory-download';
import { registerOidcSettingsRoutes } from './modules/oidc-settings';
import { registerResourceRoutes } from './modules/resource-routes';
import { registerSSHKeyImportRoutes } from './modules/sshkey-import';
import { registerUsersSettingsRoutes } from './modules/users-settings';

await bootstrapAdminAccount();

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
app = registerSSHKeyImportRoutes(app); // before the generic routes: same base paths + a literal "import" segment
app = registerInventoryDownloadRoutes(app); // same base paths + a literal "download" segment
for (const descriptor of RESOURCE_DESCRIPTORS) {
  app = registerResourceRoutes(app, descriptor);
}
app = registerAnsibleRunRoutes(app);
app = registerAnsibleJobRoutes(app);

const port = Number(process.env.PORT ?? 3000);
app.listen(port);
console.log(`api listening on :${port}`);
