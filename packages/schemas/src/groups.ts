import { z } from 'zod';
import { commonStatusFields } from './common';
import { unvalidatedPermissionSchema } from './permission-shape';

export const groupSpecSchema = z.object({
  permissions: z.array(unvalidatedPermissionSchema).default([]),
});
export type GroupSpec = z.infer<typeof groupSpecSchema>;

// No controller reconciles a Group — it's pure API-managed storage — so nothing ever populates
// these, but every kind gets a status subresource (see crd-yaml.ts), and this keeps Group
// consistent with every other kind rather than a special case.
export const groupStatusSchema = z.object(commonStatusFields);
export type GroupStatus = z.infer<typeof groupStatusSchema>;
