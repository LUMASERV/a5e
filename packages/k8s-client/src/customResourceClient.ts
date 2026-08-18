import * as k8s from '@kubernetes/client-node';
import { setHeaderOptions } from '@kubernetes/client-node';
import type { ConfigurationOptions, ObservableMiddleware } from '@kubernetes/client-node';
import type { ResourceDescriptor } from '@a5e/schemas';
import { API_GROUP, API_VERSION } from './crdRegistry';

/**
 * Every call requires an explicit caller identity — there is no parameter you can simply omit.
 * Two shapes:
 *  - `'self'` — call as the process's own ServiceAccount/kubeconfig identity, no impersonation
 *    headers at all. This is what the operator uses for every call: it acts with its own RBAC
 *    grants, never on behalf of a UI user, and forcing impersonation here would need a pointless
 *    `impersonate` RBAC grant onto its own identity for no benefit (plan §3.3 — the operator's
 *    RBAC intentionally does not include impersonate verbs).
 *  - `{ impersonateUser, impersonateGroups? }` — what the API uses on behalf of a logged-in UI
 *    user (plan §4.4): every such call is impersonated, so real Kubernetes RBAC — not API code —
 *    is the source of authorization truth. Comes from the session (see auth/session.ts), set at
 *    OIDC-callback or local-login time.
 */
export type CallerIdentity = 'self' | { impersonateUser: string; impersonateGroups?: string[] };

export interface ListOptions {
  labelSelector?: string;
  fieldSelector?: string;
  limit?: number;
  continueToken?: string;
}

export interface ListResult<T> {
  items: T[];
  resourceVersion?: string;
  continueToken?: string;
  remainingItemCount?: number;
}

/**
 * client-node's `ConfigurationOptions` (as accepted by the ObjectParamAPI classes returned by
 * `kc.makeApiClient`) defaults to its RxJS-Observable-based `Middleware`, not the Promise-based
 * one — despite the confusing re-export naming at the package root (`Middleware` there is
 * actually aliased to the Promise-based type; the Observable one is `ObservableMiddleware`).
 * Rather than hand-write Observable-returning middleware, reuse the library's own
 * `setHeaderOptions` helper (dist/middleware.ts), which builds correctly-typed
 * Observable middleware and chains it via `middlewareMergeStrategy: 'append'`.
 *
 * `identity: 'self'` returns empty options — no Impersonate-* headers, the call goes out as the
 * process's own authenticated identity (the operator's case). Otherwise sets `Impersonate-User`
 * and, at most, the first `impersonateGroups` entry: @kubernetes/client-node v2's header type is
 * a plain `Record<string,string>` (see `RequestContext.setHeaderParam`), which has no way to emit
 * two separate `Impersonate-Group` lines the way `kubectl`/client-go do. Multi-group impersonation
 * needs a raw-dispatcher bypass — tracked as a follow-up for task 10 (OIDC group-claim mapping).
 */
function withImpersonation(identity: CallerIdentity): ConfigurationOptions<ObservableMiddleware> {
  if (identity === 'self') return {};
  let opts = setHeaderOptions('Impersonate-User', identity.impersonateUser);
  if (identity.impersonateGroups?.[0]) {
    opts = setHeaderOptions('Impersonate-Group', identity.impersonateGroups[0], opts);
  }
  return opts;
}

/**
 * `patch*CustomObject` defaults to `application/json-patch+json` (RFC 6902 op array) when no
 * override is given (see the generated client's `getPreferredMediaType` call), but every caller
 * in this package passes a plain merge object. Force the header to `application/merge-patch+json`
 * so a plain `{ spec: {...} }`/`{ status: {...} }` body is interpreted correctly instead of being
 * rejected as a malformed JSON Patch.
 */
function withMergePatchContentType(
  opts: ConfigurationOptions<ObservableMiddleware>,
): ConfigurationOptions<ObservableMiddleware> {
  return setHeaderOptions('Content-Type', 'application/merge-patch+json', opts);
}

export class CustomResourceClient {
  private readonly api: k8s.CustomObjectsApi;

  constructor(private readonly kc: k8s.KubeConfig) {
    this.api = kc.makeApiClient(k8s.CustomObjectsApi);
  }

  async get<T>(
    descriptor: ResourceDescriptor,
    name: string,
    identity: CallerIdentity,
    namespace?: string,
  ): Promise<T> {
    if (descriptor.scope === 'Namespaced') {
      if (!namespace) throw new Error(`${descriptor.kind} is namespaced — namespace is required`);
      return (await this.api.getNamespacedCustomObject(
        { group: API_GROUP, version: API_VERSION, namespace, plural: descriptor.plural, name },
        withImpersonation(identity),
      )) as T;
    }
    return (await this.api.getClusterCustomObject(
      { group: API_GROUP, version: API_VERSION, plural: descriptor.plural, name },
      withImpersonation(identity),
    )) as T;
  }

  async list<T>(
    descriptor: ResourceDescriptor,
    identity: CallerIdentity,
    namespace?: string,
    options: ListOptions = {},
  ): Promise<ListResult<T>> {
    const raw =
      descriptor.scope === 'Namespaced'
        ? await (() => {
            if (!namespace) throw new Error(`${descriptor.kind} is namespaced — namespace is required`);
            return this.api.listNamespacedCustomObject(
              {
                group: API_GROUP,
                version: API_VERSION,
                namespace,
                plural: descriptor.plural,
                labelSelector: options.labelSelector,
                fieldSelector: options.fieldSelector,
                limit: options.limit,
                _continue: options.continueToken,
              },
              withImpersonation(identity),
            );
          })()
        : await this.api.listClusterCustomObject(
            {
              group: API_GROUP,
              version: API_VERSION,
              plural: descriptor.plural,
              labelSelector: options.labelSelector,
              fieldSelector: options.fieldSelector,
              limit: options.limit,
              _continue: options.continueToken,
            },
            withImpersonation(identity),
          );
    // biome-ignore lint/suspicious/noExplicitAny: raw k8s list response
    const list = raw as any;
    return {
      items: (list.items ?? []) as T[],
      resourceVersion: list.metadata?.resourceVersion,
      continueToken: list.metadata?.continue,
      remainingItemCount: list.metadata?.remainingItemCount,
    };
  }

  /** List a Namespaced kind across every namespace at once — what the operator uses to reconcile cluster-wide. */
  async listAllNamespaces<T>(
    descriptor: ResourceDescriptor,
    identity: CallerIdentity,
    options: ListOptions = {},
  ): Promise<ListResult<T>> {
    if (descriptor.scope !== 'Namespaced') {
      throw new Error(`${descriptor.kind} is not namespaced — use list() instead`);
    }
    const raw = await this.api.listCustomObjectForAllNamespaces(
      {
        group: API_GROUP,
        version: API_VERSION,
        resourcePlural: descriptor.plural,
        labelSelector: options.labelSelector,
        fieldSelector: options.fieldSelector,
        limit: options.limit,
        _continue: options.continueToken,
      },
      withImpersonation(identity),
    );
    // biome-ignore lint/suspicious/noExplicitAny: raw k8s list response
    const list = raw as any;
    return {
      items: (list.items ?? []) as T[],
      resourceVersion: list.metadata?.resourceVersion,
      continueToken: list.metadata?.continue,
      remainingItemCount: list.metadata?.remainingItemCount,
    };
  }

  async create<T>(
    descriptor: ResourceDescriptor,
    body: unknown,
    identity: CallerIdentity,
    namespace?: string,
  ): Promise<T> {
    if (descriptor.scope === 'Namespaced') {
      if (!namespace) throw new Error(`${descriptor.kind} is namespaced — namespace is required`);
      return (await this.api.createNamespacedCustomObject(
        { group: API_GROUP, version: API_VERSION, namespace, plural: descriptor.plural, body },
        withImpersonation(identity),
      )) as T;
    }
    return (await this.api.createClusterCustomObject(
      { group: API_GROUP, version: API_VERSION, plural: descriptor.plural, body },
      withImpersonation(identity),
    )) as T;
  }

  /** Full replace — caller must include the current `resourceVersion` in `body.metadata`. */
  async replace<T>(
    descriptor: ResourceDescriptor,
    name: string,
    body: unknown,
    identity: CallerIdentity,
    namespace?: string,
  ): Promise<T> {
    if (descriptor.scope === 'Namespaced') {
      if (!namespace) throw new Error(`${descriptor.kind} is namespaced — namespace is required`);
      return (await this.api.replaceNamespacedCustomObject(
        { group: API_GROUP, version: API_VERSION, namespace, plural: descriptor.plural, name, body },
        withImpersonation(identity),
      )) as T;
    }
    return (await this.api.replaceClusterCustomObject(
      { group: API_GROUP, version: API_VERSION, plural: descriptor.plural, name, body },
      withImpersonation(identity),
    )) as T;
  }

  async patch<T>(
    descriptor: ResourceDescriptor,
    name: string,
    patchBody: unknown,
    identity: CallerIdentity,
    namespace?: string,
  ): Promise<T> {
    const opts = withMergePatchContentType(withImpersonation(identity));
    if (descriptor.scope === 'Namespaced') {
      if (!namespace) throw new Error(`${descriptor.kind} is namespaced — namespace is required`);
      return (await this.api.patchNamespacedCustomObject(
        { group: API_GROUP, version: API_VERSION, namespace, plural: descriptor.plural, name, body: patchBody },
        opts,
      )) as T;
    }
    return (await this.api.patchClusterCustomObject(
      { group: API_GROUP, version: API_VERSION, plural: descriptor.plural, name, body: patchBody },
      opts,
    )) as T;
  }

  async patchStatus<T>(
    descriptor: ResourceDescriptor,
    name: string,
    status: unknown,
    identity: CallerIdentity,
    namespace?: string,
  ): Promise<T> {
    const body = { status };
    const opts = withMergePatchContentType(withImpersonation(identity));
    if (descriptor.scope === 'Namespaced') {
      if (!namespace) throw new Error(`${descriptor.kind} is namespaced — namespace is required`);
      return (await this.api.patchNamespacedCustomObjectStatus(
        { group: API_GROUP, version: API_VERSION, namespace, plural: descriptor.plural, name, body },
        opts,
      )) as T;
    }
    return (await this.api.patchClusterCustomObjectStatus(
      { group: API_GROUP, version: API_VERSION, plural: descriptor.plural, name, body },
      opts,
    )) as T;
  }

  async delete(
    descriptor: ResourceDescriptor,
    name: string,
    identity: CallerIdentity,
    namespace?: string,
  ): Promise<void> {
    if (descriptor.scope === 'Namespaced') {
      if (!namespace) throw new Error(`${descriptor.kind} is namespaced — namespace is required`);
      await this.api.deleteNamespacedCustomObject(
        { group: API_GROUP, version: API_VERSION, namespace, plural: descriptor.plural, name },
        withImpersonation(identity),
      );
      return;
    }
    await this.api.deleteClusterCustomObject(
      { group: API_GROUP, version: API_VERSION, plural: descriptor.plural, name },
      withImpersonation(identity),
    );
  }
}
