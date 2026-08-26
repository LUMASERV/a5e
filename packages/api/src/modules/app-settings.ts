import { authorize } from '../auth/authorize';
import { extractBearerToken } from '../auth/session';
import { readAppSettings, writeAppSettings } from '../lib/app-settings-store';
import type { AnyElysia } from '../lib/elysia-types';

/**
 * App-wide feature toggles (currently just `changeRequestsEnabled`). GET is readable by any
 * logged-in user — the UI needs it to decide whether to show the "Start change request" entry
 * points at all, not just to gate the admin Settings form. PUT requires "admin": this controls
 * whether the whole change-request flow exists for the install, not a per-object grant.
 */
export function registerAppSettingsRoutes(app: AnyElysia): AnyElysia {
  return app
    .get('/api/v1/config/app-settings', async ({ headers }) => {
      const auth = await authorize(extractBearerToken(headers), 'user');
      if (auth instanceof Response) return auth;
      return readAppSettings();
    })

    .put('/api/v1/config/app-settings', async ({ headers, body, set }) => {
      const auth = await authorize(extractBearerToken(headers), 'admin');
      if (auth instanceof Response) return auth;

      const b = body as { changeRequestsEnabled?: unknown };
      if (b.changeRequestsEnabled !== undefined && typeof b.changeRequestsEnabled !== 'boolean') {
        set.status = 400;
        return { error: 'changeRequestsEnabled must be a boolean' };
      }
      return writeAppSettings({ changeRequestsEnabled: b.changeRequestsEnabled });
    });
}
