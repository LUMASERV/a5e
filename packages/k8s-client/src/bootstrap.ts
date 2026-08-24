import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as k8s from '@kubernetes/client-node';

/**
 * Bun + client-node v2 (undici-based) TLS finding, confirmed by spiking against a real cluster
 * (see plan §3.6): the undici `Agent`/dispatcher's per-request `connect.ca` option is NOT
 * honored under Bun — every request fails with `SELF_SIGNED_CERT_IN_CHAIN`, even though the
 * exact same code works under Node.js unmodified.
 *
 * Bun DOES honor the global `NODE_EXTRA_CA_CERTS` env var for trusting an additional CA — BUT
 * (confirmed by testing) Bun reads it exactly once at process startup, before any user JS runs.
 * Setting `process.env.NODE_EXTRA_CA_CERTS` from within an already-running Bun process, as this
 * function used to do, has **no effect** — the TLS trust store is already snapshotted by then.
 * The env var must be present in the process environment *before* `bun run`/`bun <file>` is
 * invoked. In practice:
 *   - In-cluster deployment: set it as a static Dockerfile `ENV` /  Deployment `env:` entry
 *     pointing at the well-known mounted path, e.g.
 *     `NODE_EXTRA_CA_CERTS=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt` — this path is
 *     fixed at image/manifest-authoring time, so no runtime discovery is needed.
 *   - Local dev: the `dev` scripts export it (computed once, e.g. from the OrbStack cluster CA)
 *     before invoking bun — see the root `package.json` `dev:operator`/`dev:api` scripts.
 * This module still writes out a CA file and sets `process.env.NODE_EXTRA_CA_CERTS` as a
 * best-effort fallback (harmless, and it *is* what Node needs/uses if this ever runs there), but
 * callers on Bun must not rely on it alone — prefer the env-var-at-launch approaches above.
 *
 * Separately confirmed: mutual-TLS client-certificate auth (kubeconfig `client-certificate-data`
 * + `client-key-data`) still fails under Bun even with the CA fixed (server returns 401 — the
 * client cert isn't actually being presented by undici's Bun-backed socket). Bearer-token auth
 * (in-cluster ServiceAccount token, or an external kubeconfig using a token/exec plugin) works
 * correctly once the CA is trusted (this whole flow — CRUD, patch, impersonation headers, and a
 * reconnecting watch — was smoke-tested end-to-end against a live cluster). This is not a
 * blocker in practice: in-cluster deployment always uses a ServiceAccount token, never mTLS. It
 * only means a *local* kubeconfig that authenticates via client certificates (e.g. a cluster's
 * default admin kubeconfig, including OrbStack's) cannot be used directly under Bun — use a
 * ServiceAccount token instead for local dev (see `loadKubeConfigFromToken` below and
 * scripts/seed-fixtures.ts), or fall back to running under Node for that one case. This module
 * refuses to silently proceed with a client-cert kubeconfig under Bun; it throws with a clear
 * message instead of failing later with a confusing 401.
 */
function ensureCaTrusted(caData: string | undefined, caFile: string | undefined) {
  let resolvedCaFile = caFile;
  if (!resolvedCaFile && caData) {
    const dir = mkdtempSync(join(tmpdir(), 'a5e-ca-'));
    resolvedCaFile = join(dir, 'ca.crt');
    writeFileSync(resolvedCaFile, caData);
  }
  if (resolvedCaFile && existsSync(resolvedCaFile) && !process.env.NODE_EXTRA_CA_CERTS) {
    process.env.NODE_EXTRA_CA_CERTS = resolvedCaFile;
  }
  if (isBunRuntime() && resolvedCaFile && process.env.NODE_EXTRA_CA_CERTS !== resolvedCaFile) {
    console.warn(
      `[k8s-client] NODE_EXTRA_CA_CERTS is not set to the cluster CA (${resolvedCaFile}) at Bun process startup — setting it now has no effect. k8s API calls will likely fail with SELF_SIGNED_CERT_IN_CHAIN. Export NODE_EXTRA_CA_CERTS before launching this process (see the comment in packages/k8s-client/src/bootstrap.ts).`,
    );
  }
}

function isBunRuntime(): boolean {
  return typeof (globalThis as Record<string, unknown>).Bun !== 'undefined';
}

/** Applies the Bun CA-trust workaround and the mTLS guard to an already-loaded KubeConfig. */
export function applyBunTlsWorkaround(kc: k8s.KubeConfig): void {
  const cluster = kc.getCurrentCluster();
  ensureCaTrusted(cluster?.caData, cluster?.caFile);

  const user = kc.getCurrentUser();
  if (isBunRuntime() && user?.certData && user?.keyData) {
    throw new Error(
      'This kubeconfig authenticates via a client certificate (mTLS), which is not reliably ' +
        'supported by @kubernetes/client-node under Bun (see packages/k8s-client/src/bootstrap.ts). ' +
        'Use a ServiceAccount bearer token instead for local dev (see scripts/seed-fixtures.ts), ' +
        'or run this process under Node.',
    );
  }
}

export interface LoadKubeConfigOptions {
  /** Force a specific mode instead of auto-detecting in-cluster vs kubeconfig. */
  mode?: 'in-cluster' | 'kubeconfig';
}

/**
 * Loads the active KubeConfig, applying the Bun CA-trust workaround above before any API client
 * is constructed. Always call this instead of constructing `k8s.KubeConfig` directly.
 */
export function loadKubeConfig(options: LoadKubeConfigOptions = {}): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();

  if (options.mode === 'in-cluster') {
    kc.loadFromCluster();
  } else {
    kc.loadFromDefault();
  }

  applyBunTlsWorkaround(kc);
  return kc;
}

export interface TokenKubeConfigOptions {
  server: string;
  token: string;
  /** Path to a CA bundle file. Provide this or `caData`, not both. */
  caFile?: string;
  /** Inline PEM CA bundle contents. */
  caData?: string;
}

/**
 * Builds a KubeConfig from a bearer token directly, bypassing whatever the default/current
 * kubeconfig context authenticates with. Use this for local dev against a cluster whose default
 * kubeconfig uses client certificates (e.g. OrbStack's), which don't work under Bun — see the
 * module-level comment above. `scripts/seed-fixtures.ts` uses this with a ServiceAccount token.
 */
export function loadKubeConfigFromToken(options: TokenKubeConfigOptions): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  kc.loadFromOptions({
    clusters: [
      { name: 'cluster', server: options.server, caFile: options.caFile, caData: options.caData },
    ],
    users: [{ name: 'user', token: options.token }],
    contexts: [{ name: 'context', cluster: 'cluster', user: 'user' }],
    currentContext: 'context',
  });
  applyBunTlsWorkaround(kc);
  return kc;
}
