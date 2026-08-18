import * as k8s from '@kubernetes/client-node';
import { coreApi } from '../plugins/k8s';

/**
 * OIDC config is user-editable at runtime (Settings page), not just an env-var-at-deploy-time
 * value — so it lives in a Secret the API's own ServiceAccount can read/write directly (never
 * impersonated: this is app config, not a user-owned Kubernetes resource). RBAC for this is
 * scoped to exactly this one Secret name in the API's own namespace (see crds/rbac/api.yaml) —
 * deliberately narrower than the operator's broader Secret access.
 */
const SECRET_NAME = 'a5e-oidc-config';

function namespace(): string {
  return process.env.POD_NAMESPACE ?? 'default';
}

export interface StoredOidcConfig {
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  /** Space-separated OAuth scopes, e.g. "openid profile email". Optional — falls back to a safe
   * default (see auth/oidc.ts) when unset, since "groups" and similar non-standard scopes have
   * to actually exist on the IdP client or the whole authorization request is rejected. */
  scopes?: string;
}

function decode(data: Record<string, string> | undefined, key: string): string | undefined {
  const value = data?.[key];
  return value ? Buffer.from(value, 'base64').toString('utf8') : undefined;
}

export async function readOidcConfigSecret(): Promise<StoredOidcConfig | undefined> {
  try {
    const secret = await coreApi.readNamespacedSecret({ name: SECRET_NAME, namespace: namespace() });
    return {
      issuer: decode(secret.data, 'issuer'),
      clientId: decode(secret.data, 'clientId'),
      clientSecret: decode(secret.data, 'clientSecret'),
      scopes: decode(secret.data, 'scopes'),
    };
  } catch (err) {
    if ((err as { code?: number }).code === 404) return undefined;
    throw err;
  }
}

/**
 * Merge-patches the stored config: omitting `clientSecret` (e.g. the Settings form was
 * submitted with that field left blank) leaves the existing one untouched, so re-saving the
 * issuer/clientId never forces re-entering the secret.
 */
export async function writeOidcConfigSecret(patch: StoredOidcConfig): Promise<void> {
  const stringData: Record<string, string> = {};
  if (patch.issuer !== undefined) stringData.issuer = patch.issuer;
  if (patch.clientId !== undefined) stringData.clientId = patch.clientId;
  if (patch.clientSecret) stringData.clientSecret = patch.clientSecret;
  if (patch.scopes !== undefined) stringData.scopes = patch.scopes;

  try {
    await coreApi.patchNamespacedSecret(
      { name: SECRET_NAME, namespace: namespace(), body: { stringData } },
      k8s.setHeaderOptions('Content-Type', 'application/merge-patch+json'),
    );
  } catch (err) {
    if ((err as { code?: number }).code !== 404) throw err;
    await coreApi.createNamespacedSecret({
      namespace: namespace(),
      body: { metadata: { name: SECRET_NAME }, type: 'Opaque', stringData },
    });
  }
}
