import * as k8s from '@kubernetes/client-node';
import { coreApi } from '../plugins/k8s';

/**
 * App-wide feature toggles editable at runtime (Settings page), same "not a CRD" reasoning as
 * lib/oidc-config-store.ts's OIDC config — this is app config, not a user-owned Kubernetes
 * resource. Unlike OIDC config there's nothing sensitive here, so this lives in a ConfigMap
 * rather than a Secret. RBAC is scoped to exactly this one ConfigMap name in the API's own
 * namespace (see crds/rbac/api.yaml), same pattern as the OIDC Secret.
 */
const CONFIGMAP_NAME = 'a5e-app-settings';

function namespace(): string {
  return process.env.POD_NAMESPACE ?? 'default';
}

export interface StoredAppSettings {
  /** Whether any logged-in user may propose a ChangeRequest (draft-and-stage flow, plus the
   * "stage on denied" upsell) — see modules/change-requests.ts. Undefined (ConfigMap/key missing)
   * means "unset", resolved to the default of `true` by readAppSettings() below, so an install
   * that predates this toggle keeps behaving exactly as it did before it existed. */
  changeRequestsEnabled?: boolean;
}

export interface AppSettings {
  changeRequestsEnabled: boolean;
}

const DEFAULTS: AppSettings = { changeRequestsEnabled: true };

export async function readAppSettings(): Promise<AppSettings> {
  try {
    const cm = await coreApi.readNamespacedConfigMap({
      name: CONFIGMAP_NAME,
      namespace: namespace(),
    });
    const raw = cm.data?.changeRequestsEnabled;
    return {
      changeRequestsEnabled: raw === undefined ? DEFAULTS.changeRequestsEnabled : raw === 'true',
    };
  } catch (err) {
    if ((err as { code?: number }).code === 404) return DEFAULTS;
    throw err;
  }
}

export async function writeAppSettings(patch: StoredAppSettings): Promise<AppSettings> {
  const data: Record<string, string> = {};
  if (patch.changeRequestsEnabled !== undefined) {
    data.changeRequestsEnabled = String(patch.changeRequestsEnabled);
  }

  try {
    await coreApi.patchNamespacedConfigMap(
      { name: CONFIGMAP_NAME, namespace: namespace(), body: { data } },
      k8s.setHeaderOptions('Content-Type', 'application/merge-patch+json'),
    );
  } catch (err) {
    if ((err as { code?: number }).code !== 404) throw err;
    await coreApi.createNamespacedConfigMap({
      namespace: namespace(),
      body: { metadata: { name: CONFIGMAP_NAME }, data },
    });
  }
  return readAppSettings();
}
