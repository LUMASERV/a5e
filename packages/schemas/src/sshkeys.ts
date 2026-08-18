import { z } from 'zod';
import { commonStatusFields, secretKeyRefSchema } from './common';

export const ansibleSSHKeySpecSchema = z.object({
  secretRef: secretKeyRefSchema,
  passphraseSecretRef: secretKeyRefSchema.optional(),
});
export type AnsibleSSHKeySpec = z.infer<typeof ansibleSSHKeySpecSchema>;

// ClusterAnsibleSSHKey: secretRef/passphraseSecretRef.namespace is REQUIRED (no owning ns to default to).
export const clusterAnsibleSSHKeySpecSchema = z.object({
  secretRef: secretKeyRefSchema.extend({ namespace: z.string() }),
  passphraseSecretRef: secretKeyRefSchema.extend({ namespace: z.string() }).optional(),
});
export type ClusterAnsibleSSHKeySpec = z.infer<typeof clusterAnsibleSSHKeySpecSchema>;

export const ansibleSSHKeyStatusSchema = z.object({
  ...commonStatusFields,
  publicKey: z.string().optional(),
  fingerprint: z.string().optional(),
  keyType: z.enum(['rsa', 'ed25519', 'ecdsa']).optional(),
});
export type AnsibleSSHKeyStatus = z.infer<typeof ansibleSSHKeyStatusSchema>;

export const clusterAnsibleSSHKeyStatusSchema = ansibleSSHKeyStatusSchema;
