import { API_GROUP, API_GROUP_VERSION, RESOURCE_DESCRIPTORS_BY_KIND } from '@a5e/schemas';
import type {
  AnsibleJobSpec,
  AnsibleJobStatus,
  AnsibleRunSpec,
  AnsibleRunStatus,
  CustomResource,
} from '@a5e/schemas';
import { authorize } from '../auth/authorize';
import { canAct, resolveEffectivePermissions } from '../auth/permission-engine';
import { extractBearerToken } from '../auth/session';
import type { AnyElysia } from '../lib/elysia-types';
import { client } from '../plugins/k8s';

const jobDescriptor = RESOURCE_DESCRIPTORS_BY_KIND.AnsibleJob!;
const runDescriptor = RESOURCE_DESCRIPTORS_BY_KIND.AnsibleRun!;
const JOB_LABEL = `${API_GROUP}/job`;

/**
 * Manual "run now" trigger, separate from the cron path: gated by the caller's `trigger` grant on
 * the AnsibleJob (see auth/permission-engine.ts), then executed as the API's own identity — same
 * as every other CRUD route post-RBAC-replacement. The operator's own cron ticker
 * (controllers/ansiblejob-controller.ts) is the only thing that ever spawns a Run as its own
 * identity for a scheduled tick, which has no user session to check permissions against.
 */
export function registerAnsibleJobRoutes(app: AnyElysia): AnyElysia {
  return app.post(
    '/api/v1/namespaces/:namespace/ansiblejobs/:name/trigger',
    async ({ params, headers, set }) => {
      const auth = await authorize(extractBearerToken(headers), 'user');
      if (auth instanceof Response) return auth;

      const job = await client.get<CustomResource<AnsibleJobSpec, AnsibleJobStatus>>(
        jobDescriptor,
        params.name,
        'self',
        params.namespace,
      );
      const perms = await resolveEffectivePermissions(auth.session, auth.role);
      if (
        !canAct(
          perms,
          { type: 'AnsibleJob', namespace: params.namespace, labels: job.metadata.labels },
          'trigger',
        )
      ) {
        set.status = 403;
        return {
          error: 'forbidden',
          type: 'AnsibleJob',
          namespace: params.namespace,
          action: 'trigger',
        };
      }

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
        'self',
        params.namespace,
      );
    },
  );
}
