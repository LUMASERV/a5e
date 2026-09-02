import { labelSelectorMatches, parseLabelSelectorString } from '@a5e/k8s-client';
import type { ResourceDescriptor } from '@a5e/schemas';
import { authorize } from '../auth/authorize';
import {
  canAct,
  executeListPlan,
  hasAction,
  mergedLabelsAfterPatch,
  planList,
  resolveEffectivePermissions,
} from '../auth/permission-engine';
import { type SecretUseDenial, deniedSecretUse } from '../auth/secret-use';
import { extractBearerToken } from '../auth/session';
import type { AnyElysia } from '../lib/elysia-types';
import { sseResponse } from '../lib/sse';
import { WatchHub } from '../lib/watch-hub';
import { client, kc } from '../plugins/k8s';

const watchHub = new WatchHub(kc, client);

type Verb = 'list' | 'watch' | 'get' | 'create' | 'replace' | 'patch' | 'delete';

export interface ResourceRouteOptions {
  /** Verbs whose route is not registered here at all — the caller wires its own handler
   * elsewhere (used by ChangeRequest's create/delete — see modules/change-requests.ts). */
  skipRoutes?: Verb[];
}

function forbidden(
  set: { status: number },
  type: string,
  namespace: string | undefined,
  action: string,
) {
  set.status = 403;
  return { error: 'forbidden', type, namespace, action };
}

/**
 * A write blocked not by the kind's own grant but by a `Secret` the body wants dereferenced (see
 * auth/secret-use.ts). Unlike `forbidden` above, `error` carries the specific reason rather than
 * a bare 'forbidden': "you can create hosts, just not ones pointing at that Secret" is not
 * something the caller can work out from the type/action pair alone, and the UI surfaces `error`
 * verbatim. Still a 403, so the stage-as-change-request on-ramp (useStageOnDenied.ts) still
 * offers itself — an approver who does hold `use` can apply the very same change.
 */
function forbiddenSecretUse(set: { status: number }, denial: SecretUseDenial) {
  set.status = 403;
  return {
    error: denial.message,
    type: 'Secret',
    namespace: denial.namespace,
    name: denial.name,
    action: 'use',
  };
}

/**
 * Registers the standard 7-route set (list/get/create/replace/patch/delete/watch) for one CRD
 * kind, driven entirely by its `ResourceDescriptor`. Every Kubernetes call goes out as the API's
 * own identity (`'self'`) — the fine-grained `Permission` model (auth/permission-engine.ts), not
 * k8s RBAC/impersonation, decides every allow/deny here.
 */
export function registerResourceRoutes(
  initialApp: AnyElysia,
  descriptor: ResourceDescriptor,
  options: ResourceRouteOptions = {},
): AnyElysia {
  let app = initialApp;
  const isNamespaced = descriptor.scope === 'Namespaced';
  const basePath = isNamespaced
    ? `/api/v1/namespaces/:namespace/${descriptor.plural}`
    : `/api/v1/${descriptor.plural}`;
  const skip = new Set(options.skipRoutes ?? []);

  if (!skip.has('list')) {
    app = app.get(basePath, async ({ params, query, headers, set }) => {
      const auth = await authorize(extractBearerToken(headers), 'user');
      if (auth instanceof Response) return auth;
      const namespace = isNamespaced ? (params as Record<string, string>).namespace : undefined;

      const perms = await resolveEffectivePermissions(auth.session, auth.role);
      const plan = planList(perms, descriptor, 'list', namespace);
      if (plan.mode === 'denied') return forbidden(set, descriptor.kind, namespace, 'list');

      const result = await executeListPlan(client, descriptor, plan, {
        extraLabelSelector: query.labelSelector,
        fieldSelector: query.fieldSelector,
        limit: query.limit ? Number(query.limit) : undefined,
        continueToken: query.continue,
      });
      set.headers['content-type'] = 'application/json';
      return {
        items: result.items,
        metadata: {
          resourceVersion: result.resourceVersion,
          continue: result.continueToken,
          remainingItemCount: result.remainingItemCount,
        },
      };
    });
  }

  if (!skip.has('watch')) {
    app = app.get(`${basePath}/watch`, async ({ params, query, headers, request, set }) => {
      const auth = await authorize(extractBearerToken(headers), 'user');
      if (auth instanceof Response) return auth;
      const namespace = isNamespaced ? (params as Record<string, string>).namespace : undefined;

      const perms = await resolveEffectivePermissions(auth.session, auth.role);
      if (!hasAction(perms, descriptor.kind, 'watch')) {
        return forbidden(set, descriptor.kind, namespace, 'watch');
      }
      const requestedSelector = parseLabelSelectorString(query.labelSelector);
      const filter = (obj: {
        metadata?: { namespace?: string; labels?: Record<string, string> };
      }) =>
        labelSelectorMatches(requestedSelector, obj.metadata?.labels) &&
        canAct(
          perms,
          {
            type: descriptor.kind,
            namespace: obj.metadata?.namespace,
            labels: obj.metadata?.labels,
          },
          'watch',
        );

      return sseResponse(request.signal, async (send) => {
        const { unsubscribe } = await watchHub.subscribe(descriptor, namespace, filter, (event) =>
          send(event.type, event.object),
        );
        return unsubscribe;
      });
    });
  }

  if (!skip.has('get')) {
    app = app.get(`${basePath}/:name`, async ({ params, headers, set }) => {
      const auth = await authorize(extractBearerToken(headers), 'user');
      if (auth instanceof Response) return auth;
      const p = params as Record<string, string>;
      const namespace = isNamespaced ? p.namespace : undefined;

      const obj = await client.get<{
        metadata: { namespace?: string; labels?: Record<string, string> };
      }>(descriptor, p.name!, 'self', namespace);
      const perms = await resolveEffectivePermissions(auth.session, auth.role);
      if (
        !canAct(perms, { type: descriptor.kind, namespace, labels: obj.metadata.labels }, 'get')
      ) {
        return forbidden(set, descriptor.kind, namespace, 'get');
      }
      return obj;
    });
  }

  if (!skip.has('create')) {
    app = app.post(basePath, async ({ params, body, headers, set }) => {
      const auth = await authorize(extractBearerToken(headers), 'user');
      if (auth instanceof Response) return auth;
      const namespace = isNamespaced ? (params as Record<string, string>).namespace : undefined;

      const perms = await resolveEffectivePermissions(auth.session, auth.role);
      const desiredLabels = (body as { metadata?: { labels?: Record<string, string> } })?.metadata
        ?.labels;
      if (!canAct(perms, { type: descriptor.kind, namespace, labels: desiredLabels }, 'create')) {
        return forbidden(set, descriptor.kind, namespace, 'create');
      }
      const secretDenial = deniedSecretUse(perms, descriptor.kind, namespace, body);
      if (secretDenial) return forbiddenSecretUse(set, secretDenial);

      set.status = 201;
      return client.create(descriptor, body, 'self', namespace);
    });
  }

  if (!skip.has('replace')) {
    app = app.put(`${basePath}/:name`, async ({ params, body, headers, set }) => {
      const auth = await authorize(extractBearerToken(headers), 'user');
      if (auth instanceof Response) return auth;
      const p = params as Record<string, string>;
      const namespace = isNamespaced ? p.namespace : undefined;

      const current = await client.get<{
        metadata: { namespace?: string; labels?: Record<string, string> };
      }>(descriptor, p.name!, 'self', namespace);
      const perms = await resolveEffectivePermissions(auth.session, auth.role);
      const desiredLabels = (body as { metadata?: { labels?: Record<string, string> } })?.metadata
        ?.labels;
      const ok =
        canAct(
          perms,
          { type: descriptor.kind, namespace, labels: current.metadata.labels },
          'update',
        ) && canAct(perms, { type: descriptor.kind, namespace, labels: desiredLabels }, 'update');
      if (!ok) return forbidden(set, descriptor.kind, namespace, 'update');
      const secretDenial = deniedSecretUse(perms, descriptor.kind, namespace, body);
      if (secretDenial) return forbiddenSecretUse(set, secretDenial);

      return client.replace(descriptor, p.name!, body, 'self', namespace);
    });
  }

  if (!skip.has('patch')) {
    app = app.patch(`${basePath}/:name`, async ({ params, body, headers, set }) => {
      const auth = await authorize(extractBearerToken(headers), 'user');
      if (auth instanceof Response) return auth;
      const p = params as Record<string, string>;
      const namespace = isNamespaced ? p.namespace : undefined;

      const current = await client.get<{
        metadata: { namespace?: string; labels?: Record<string, string> };
      }>(descriptor, p.name!, 'self', namespace);
      const perms = await resolveEffectivePermissions(auth.session, auth.role);
      const desiredLabels = mergedLabelsAfterPatch(current.metadata.labels, body);
      const ok =
        canAct(
          perms,
          { type: descriptor.kind, namespace, labels: current.metadata.labels },
          'update',
        ) && canAct(perms, { type: descriptor.kind, namespace, labels: desiredLabels }, 'update');
      if (!ok) return forbidden(set, descriptor.kind, namespace, 'update');
      const secretDenial = deniedSecretUse(perms, descriptor.kind, namespace, body);
      if (secretDenial) return forbiddenSecretUse(set, secretDenial);

      return client.patch(descriptor, p.name!, body, 'self', namespace);
    });
  }

  if (!skip.has('delete')) {
    app = app.delete(`${basePath}/:name`, async ({ params, headers, set }) => {
      const auth = await authorize(extractBearerToken(headers), 'user');
      if (auth instanceof Response) return auth;
      const p = params as Record<string, string>;
      const namespace = isNamespaced ? p.namespace : undefined;

      const current = await client.get<{
        metadata: { namespace?: string; labels?: Record<string, string> };
      }>(descriptor, p.name!, 'self', namespace);
      const perms = await resolveEffectivePermissions(auth.session, auth.role);
      if (
        !canAct(
          perms,
          { type: descriptor.kind, namespace, labels: current.metadata.labels },
          'delete',
        )
      ) {
        return forbidden(set, descriptor.kind, namespace, 'delete');
      }

      await client.delete(descriptor, p.name!, 'self', namespace);
      set.status = 204;
    });
  }

  return app;
}
