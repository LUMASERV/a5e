import { z } from 'zod';

export const API_GROUP = 'a5e.k8s.rocks';
export const API_VERSION = 'v1alpha1';
export const API_GROUP_VERSION = `${API_GROUP}/${API_VERSION}`;

export const labelSelectorRequirementSchema = z.object({
  key: z.string(),
  operator: z.enum(['In', 'NotIn', 'Exists', 'DoesNotExist']),
  values: z.array(z.string()).optional(),
});

export const labelSelectorSchema = z.object({
  matchLabels: z.record(z.string(), z.string()).optional(),
  matchExpressions: z.array(labelSelectorRequirementSchema).optional(),
});
export type LabelSelector = z.infer<typeof labelSelectorSchema>;

export const conditionSchema = z.object({
  type: z.string(),
  status: z.enum(['True', 'False', 'Unknown']),
  reason: z.string(),
  message: z.string(),
  observedGeneration: z.number().int().optional(),
  lastTransitionTime: z.string(),
});
export type Condition = z.infer<typeof conditionSchema>;

export const commonStatusFields = {
  observedGeneration: z.number().int().optional(),
  conditions: z.array(conditionSchema).optional(),
};

export const configMapKeyRefSchema = z.object({
  name: z.string(),
  namespace: z.string().optional(),
  key: z.string().optional(),
});
export type ConfigMapKeyRef = z.infer<typeof configMapKeyRefSchema>;

export const secretKeyRefSchema = z.object({
  name: z.string(),
  namespace: z.string().optional(),
  key: z.string().optional(),
});
export type SecretKeyRef = z.infer<typeof secretKeyRefSchema>;
