import type { AnsibleHostSpec } from '@a5e/schemas';
import { resolveRefNamespace } from './ref-namespace';

/**
 * The one Secret-reading capability `resolveVarsBySecretRefs` needs, so this module stays free of
 * any particular core-API wrapper. The operator's `CoreResources` (operator/src/k8s/core.ts)
 * already satisfies it structurally; the API passes a thin adapter over its own `coreApi`.
 */
export interface SecretReader {
  getSecret(namespace: string, name: string): Promise<{ data?: Record<string, string> }>;
}

/** One resolved `varsBySecretRef` entry — kept as its own object rather than pre-flattened so the
 * operator can mount each Secret separately and the API can mask each one's values. */
export interface ResolvedVarsSecret {
  namespace: string;
  name: string;
  /**
   * The Secret's `data` exactly as read: base64, byte-for-byte. Each key is one host var's name.
   *
   * Deliberately not pre-decoded to text. The operator only ever needs the key names (to render
   * the inventory's lookups) plus this map verbatim (to copy into the run-owned Secret), so
   * keeping it encoded means one read instead of two and a copy that can't be corrupted by a
   * UTF-8 round trip of a Secret holding arbitrary bytes. `mergeSecretVars` decodes, for the one
   * caller that renders values as text — and masks them as it does (api/inventory-download.ts).
   */
  data: Record<string, string>;
  /**
   * Populated by run-controller.ts after copying this Secret into a run-owned one — the mount
   * name under `/host-vars/<mountName>/<key>` that the rendered inventory's `lookup('file', ...)`
   * expressions point at, the same host-property-not-run-property pattern `sshKeyMountName` uses.
   */
  mountName?: string;
}

/** Carries the underlying k8s HTTP status through, so a missing Secret surfaces as a 404 with a
 * useful message rather than an opaque 500 (see the API's `onError` in api/src/index.ts). */
export class HostVarsResolveError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'HostVarsResolveError';
  }
}

interface HostVarsSource {
  kind: string;
  name: string;
  /** `undefined` for a ClusterAnsibleHost — see resolveRefNamespace. */
  namespace?: string;
  spec: Pick<AnsibleHostSpec, 'varsBySecretRef'>;
}

function describe(host: HostVarsSource): string {
  return `${host.kind}/${host.namespace ?? ''}/${host.name}`;
}

/**
 * Dereferences a host's `spec.varsBySecretRef` (hosts.ts), one entry per referenced `v1/Secret`, in
 * spec order — so a caller flattening them (`mergeSecretVars`) gets "a later entry overrides an
 * earlier one" for free.
 *
 * Namespace resolution goes through `resolveRefNamespace` like every other ref in the schema: a
 * namespaced AnsibleHost may only name Secrets in its own namespace, and only a cluster-scoped
 * ClusterAnsibleHost may (and must) name one explicitly. Every caller here reads Secrets with a
 * cluster-wide-privileged identity, so skipping that check would reopen the cross-tenant Secret
 * exfiltration path ref-namespace.ts's doc comment describes.
 */
export async function resolveVarsBySecretRefs(
  secrets: SecretReader,
  host: HostVarsSource,
): Promise<ResolvedVarsSecret[]> {
  const entries = host.spec.varsBySecretRef;
  if (!entries?.length) return [];

  const resolved: ResolvedVarsSecret[] = [];
  for (const entry of entries) {
    let namespace: string | undefined;
    try {
      namespace = resolveRefNamespace('Namespaced', entry.namespace, host.namespace);
    } catch (err) {
      throw new HostVarsResolveError(
        `${describe(host)}: varsBySecretRef entry "${entry.name}": ${(err as Error).message}`,
        403,
      );
    }
    if (!namespace) {
      throw new HostVarsResolveError(
        `${describe(host)}: varsBySecretRef entry "${entry.name}" needs a namespace (this host is cluster-scoped)`,
        400,
      );
    }

    let secret: { data?: Record<string, string> };
    try {
      secret = await secrets.getSecret(namespace, entry.name);
    } catch (err) {
      throw new HostVarsResolveError(
        `${describe(host)}: cannot read Secret ${namespace}/${entry.name}: ${(err as Error).message}`,
        (err as { code?: number }).code,
      );
    }

    // `data` is the only field a read ever returns — `stringData` is write-only, so a Secret
    // created with it still comes back base64-encoded here.
    resolved.push({ namespace, name: entry.name, data: secret.data ?? {} });
  }
  return resolved;
}

/** Decodes and flattens resolved entries in spec order into one var map — later entries win.
 * Returns values IN THE CLEAR; the only caller masks them immediately (secret-masking.ts). */
export function mergeSecretVars(secrets: ResolvedVarsSecret[] | undefined): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const secret of secrets ?? []) {
    for (const [key, encoded] of Object.entries(secret.data)) {
      vars[key] = Buffer.from(encoded, 'base64').toString('utf8');
    }
  }
  return vars;
}
