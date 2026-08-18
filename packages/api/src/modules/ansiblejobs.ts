import { API_GROUP, API_GROUP_VERSION, RESOURCE_DESCRIPTORS_BY_KIND } from '@a5e/schemas';
import type { AnsibleJobSpec, AnsibleJobStatus, AnsibleRunSpec, AnsibleRunStatus, CustomResource } from '@a5e/schemas';
import { client } from '../plugins/k8s';
import { authorize } from '../auth/authorize';
import { extractBearerToken } from '../auth/session';
import type { AnyElysia } from '../lib/elysia-types';

const jobDescriptor = RESOURCE_DESCRIPTORS_BY_KIND.AnsibleJob!;
const runDescriptor = RESOURCE_DESCRIPTORS_BY_KIND.AnsibleRun!;
const JOB_LABEL = `${API_GROUP}/job`;

/**
 * Manual "run now" trigger, separate from the cron path: this creates the AnsibleRun directly
 * from the API, impersonated as whoever clicked the button — so it's authorized by the same
 * ansibleruns/create RBAC a "New Run" already requires, not by any operator-granted power. The
 * operator's own cron ticker (controllers/ansiblejob-controller.ts) is the only thing that ever
 * spawns a Run as its own identity, since a scheduled tick has no user session to impersonate.
 */
export function registerAnsibleJobRoutes(app: AnyElysia): AnyElysia {
  return app.post('/api/v1/namespaces/:namespace/ansiblejobs/:name/trigger', async ({ params, headers, set }) => {
    const auth = await authorize(extractBearerToken(headers), 'user');
    if (auth instanceof Response) return auth;
    const { session } = auth;

    const job = await client.get<CustomResource<AnsibleJobSpec, AnsibleJobStatus>>(
      jobDescriptor,
      params.name,
      session.identity,
      params.namespace,
    );

    set.status = 201;
    return client.create<CustomResource<AnsibleRunSpec, AnsibleRunStatus>>(
      runDescriptor,
      {
        apiVersion: API_GROUP_VERSION,
        kind: 'AnsibleRun',
        metadata: {
          generateName: `${job.metadata.name}-`,
          namespace: params.namespace,
          labels: { [JOB_LABEL]: job.metadata.name },
          ownerReferences: [
            {
              apiVersion: API_GROUP_VERSION,
              kind: 'AnsibleJob',
              name: job.metadata.name,
              uid: job.metadata.uid!,
              controller: true,
              blockOwnerDeletion: true,
            },
          ],
        },
        spec: job.spec.template,
      },
      session.identity,
      params.namespace,
    );
  });
}
