import type { ResourceDescriptor } from '@a5e/schemas';
import { client, kc } from '../plugins/k8s';
import { authorize } from '../auth/authorize';
import { extractBearerToken } from '../auth/session';
import type { AnyElysia } from '../lib/elysia-types';
import { WatchHub } from '../lib/watch-hub';
import { sseResponse } from '../lib/sse';

const watchHub = new WatchHub(kc, client);

/**
 * Registers the standard 7-route set (list/get/create/replace/patch/delete/watch) for one CRD
 * kind, driven entirely by its `ResourceDescriptor` — this is what keeps the 9 kinds from
 * becoming 9x hand-duplicated route modules (plan §1/§4.1). AnsibleRun's extra routes
 * (cancel/retry/logs) are registered separately in modules/ansibleruns.ts.
 */
export function registerResourceRoutes(app: AnyElysia, descriptor: ResourceDescriptor): AnyElysia {
  const isNamespaced = descriptor.scope === 'Namespaced';
  const basePath = isNamespaced
    ? `/api/v1/namespaces/:namespace/${descriptor.plural}`
    : `/api/v1/${descriptor.plural}`;

  return app
    .get(basePath, async ({ params, query, headers, set }) => {
      const auth = await authorize(extractBearerToken(headers), 'user');
      if (auth instanceof Response) return auth;
      const namespace = isNamespaced ? (params as Record<string, string>).namespace : undefined;
      const result = await client.list(descriptor, auth.session.identity, namespace, {
        labelSelector: query.labelSelector,
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
    })

    .get(`${basePath}/watch`, async ({ params, query, headers, request }) => {
      const auth = await authorize(extractBearerToken(headers), 'user');
      if (auth instanceof Response) return auth;
      const namespace = isNamespaced ? (params as Record<string, string>).namespace : undefined;
      return sseResponse(request.signal, async (send) => {
        const { unsubscribe } = await watchHub.subscribe(
          descriptor,
          auth.session.identity,
          namespace,
          query.labelSelector,
          (event) => send(event.type, event.object),
        );
        return unsubscribe;
      });
    })

    .get(`${basePath}/:name`, async ({ params, headers }) => {
      const auth = await authorize(extractBearerToken(headers), 'user');
      if (auth instanceof Response) return auth;
      const p = params as Record<string, string>;
      return client.get(descriptor, p.name!, auth.session.identity, isNamespaced ? p.namespace : undefined);
    })

    .post(basePath, async ({ params, body, headers, set }) => {
      const auth = await authorize(extractBearerToken(headers), 'user');
      if (auth instanceof Response) return auth;
      const namespace = isNamespaced ? (params as Record<string, string>).namespace : undefined;
      set.status = 201;
      return client.create(descriptor, body, auth.session.identity, namespace);
    })

    .put(`${basePath}/:name`, async ({ params, body, headers }) => {
      const auth = await authorize(extractBearerToken(headers), 'user');
      if (auth instanceof Response) return auth;
      const p = params as Record<string, string>;
      return client.replace(descriptor, p.name!, body, auth.session.identity, isNamespaced ? p.namespace : undefined);
    })

    .patch(`${basePath}/:name`, async ({ params, body, headers }) => {
      const auth = await authorize(extractBearerToken(headers), 'user');
      if (auth instanceof Response) return auth;
      const p = params as Record<string, string>;
      return client.patch(descriptor, p.name!, body, auth.session.identity, isNamespaced ? p.namespace : undefined);
    })

    .delete(`${basePath}/:name`, async ({ params, headers, set }) => {
      const auth = await authorize(extractBearerToken(headers), 'user');
      if (auth instanceof Response) return auth;
      const p = params as Record<string, string>;
      await client.delete(descriptor, p.name!, auth.session.identity, isNamespaced ? p.namespace : undefined);
      set.status = 204;
    });
}
