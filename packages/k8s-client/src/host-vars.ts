import type { AnsibleHostSpec } from '@a5e/schemas';
import { resolveRefNamespace } from './ref-namespace';

/** The `v1` kinds a `varsFrom` entry can name (hosts.ts). */
export type VarsSourceKind = 'Secret' | 'ConfigMap';

/**
 * The two reads `resolveVarsFrom` needs, so this module stays free of any particular core-API
 * wrapper. The operator's `CoreResources` (operator/src/k8s/core.ts) already satisfies it
 * structurally; the API passes a thin adapter over its own `coreApi`.
 */
export interface VarsSourceReader {
  getSecret(namespace: string, name: string): Promise<{ data?: Record<string, string> }>;
  getConfigMap(namespace: string, name: string): Promise<{ data?: Record<string, string> }>;
}

/**
 * Wraps a reader so each `kind/namespace/name` is fetched once. `resolveVarsFrom` runs per host,
 * so an object shared by N hosts would otherwise cost N serialized GETs on every run preparation
 * and every inventory download. Caching the promise also collapses concurrent reads.
 *
 * Deliberately per-resolution, not a long-lived cache: one pass sees one consistent snapshot of
 * each object, and the next pass reads fresh.
 */
export function cachingVarsSourceReader(inner: VarsSourceReader): VarsSourceReader {
  const inFlight = new Map<string, Promise<{ data?: Record<string, string> }>>();
  const once = (
    kind: VarsSourceKind,
    namespace: string,
    name: string,
    read: () => Promise<{ data?: Record<string, string> }>,
  ) => {
    const key = `${kind}/${namespace}/${name}`;
    let pending = inFlight.get(key);
    if (!pending) {
      pending = read();
      inFlight.set(key, pending);
    }
    return pending;
  };
  return {
    getSecret: (namespace, name) =>
      once('Secret', namespace, name, () => inner.getSecret(namespace, name)),
    getConfigMap: (namespace, name) =>
      once('ConfigMap', namespace, name, () => inner.getConfigMap(namespace, name)),
  };
}

/** One resolved `varsFrom` entry — kept as its own object rather than pre-flattened so the
 * operator can mount each source separately and the API can mask only the Secret-derived ones. */
export interface ResolvedVarsSource {
  kind: VarsSourceKind;
  namespace: string;
  name: string;
  /**
   * The source object's `data` exactly as read, so it can be copied into a run-owned object of
   * the same kind verbatim: base64 for a Secret, plain text for a ConfigMap. Each key is one host
   * var's name.
   *
   * Deliberately not normalized to one encoding. The operator only needs the key names (to render
   * the inventory's lookups) plus this map as-is (to copy), so leaving a Secret's bytes encoded
   * means one read instead of two and a copy that a UTF-8 round trip can't corrupt.
   * `varsSourceValues` decodes, for the one caller that renders values as text.
   */
  data: Record<string, string>;
  /**
   * Populated by run-controller.ts after copying this source into a run-owned object — the mount
   * name under `/host-vars/<mountName>/<key>` that the rendered inventory's `lookup('file', ...)`
   * expressions point at, the same host-property-not-run-property pattern `sshKeyMountName` uses.
   */
  mountName?: string;
}

/** Carries the underlying k8s HTTP status through, so a missing source surfaces as a 404 with a
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
  spec: Pick<AnsibleHostSpec, 'varsFrom'>;
}

function describe(host: HostVarsSource): string {
  return `${host.kind}/${host.namespace ?? ''}/${host.name}`;
}

/**
 * Dereferences a host's `spec.varsFrom` (hosts.ts), one entry per referenced Secret/ConfigMap, in
 * spec order — so a caller flattening them gets "a later entry overrides an earlier one" for free.
 *
 * Namespace resolution goes through `resolveRefNamespace` like every other ref in the schema: a
 * namespaced AnsibleHost may only name objects in its own namespace, and only a cluster-scoped
 * ClusterAnsibleHost may (and must) name one explicitly. Every caller here reads with a
 * cluster-wide-privileged identity, so skipping that check would reopen the cross-tenant
 * exfiltration path ref-namespace.ts's doc comment describes.
 */
export async function resolveVarsFrom(
  reader: VarsSourceReader,
  host: HostVarsSource,
): Promise<ResolvedVarsSource[]> {
  const entries = host.spec.varsFrom;
  if (!entries?.length) return [];

  const resolved: ResolvedVarsSource[] = [];
  for (const entry of entries) {
    // The CRD's CEL guarantees exactly one of the two, but this runs against whatever is stored.
    const kind: VarsSourceKind = entry.secretRef ? 'Secret' : 'ConfigMap';
    const ref = entry.secretRef ?? entry.configMapRef;
    if (!ref) {
      throw new HostVarsResolveError(
        `${describe(host)}: varsFrom entry needs exactly one of secretRef or configMapRef`,
        400,
      );
    }

    let namespace: string | undefined;
    try {
      namespace = resolveRefNamespace('Namespaced', ref.namespace, host.namespace);
    } catch (err) {
      throw new HostVarsResolveError(
        `${describe(host)}: varsFrom ${kind} "${ref.name}": ${(err as Error).message}`,
        403,
      );
    }
    if (!namespace) {
      throw new HostVarsResolveError(
        `${describe(host)}: varsFrom ${kind} "${ref.name}" needs a namespace (this host is cluster-scoped)`,
        400,
      );
    }

    let source: { data?: Record<string, string> };
    try {
      source =
        kind === 'Secret'
          ? await reader.getSecret(namespace, ref.name)
          : await reader.getConfigMap(namespace, ref.name);
    } catch (err) {
      throw new HostVarsResolveError(
        `${describe(host)}: cannot read ${kind} ${namespace}/${ref.name}: ${(err as Error).message}`,
        (err as { code?: number }).code,
      );
    }

    // `data` is the only field a Secret read returns — `stringData` is write-only, so a Secret
    // created with it still comes back base64-encoded. A ConfigMap's `data` is already plain text
    // (`binaryData` is deliberately not supported: an Ansible var is text).
    resolved.push({ kind, namespace, name: ref.name, data: source.data ?? {} });
  }
  return resolved;
}

/** This source's vars as text. Values are IN THE CLEAR — a `Secret` source's must be masked
 * before they reach a client (secret-masking.ts); a `ConfigMap`'s need not be. */
export function varsSourceValues(source: ResolvedVarsSource): Record<string, string> {
  if (source.kind === 'ConfigMap') return { ...source.data };
  const values: Record<string, string> = {};
  for (const [key, encoded] of Object.entries(source.data)) {
    values[key] = Buffer.from(encoded, 'base64').toString('utf8');
  }
  return values;
}
