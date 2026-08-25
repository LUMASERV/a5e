import { z } from 'zod';
import { labelSelectorSchema } from './common';

/**
 * A loose, structurally-identical copy of `permissionSchema` (see permissions.ts) for embedding in
 * a CRD spec (`Group.spec.permissions`, `User.spec.permissions`) — `type`/`actions` are plain
 * strings here rather than the strict PERMISSION_TYPES/PERMISSION_ACTIONS enums. permissions.ts
 * derives PERMISSION_TYPES from RESOURCE_DESCRIPTORS (crd-meta.ts), and crd-meta.ts needs this
 * shape to register the Group/User descriptors — importing the strict schema here would be
 * circular. Real validation against the current PERMISSION_TYPES/PERMISSION_ACTIONS enums happens
 * once, at the route layer (permissions-settings.ts/users-settings.ts), the same way
 * changeItemSchema's `type: z.string()` defers kind validation to change-requests.ts's handler.
 */
export const unvalidatedPermissionSchema = z.object({
  type: z.string(),
  namespaces: z.array(z.string()).default([]),
  labelSelector: labelSelectorSchema.optional(),
  actions: z.array(z.string()).min(1),
});
