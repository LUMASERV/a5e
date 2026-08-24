import { z } from 'zod';
import { commonStatusFields, configMapKeyRefSchema, secretKeyRefSchema } from './common';

export const galaxyRoleRequirementSchema = z.object({
  name: z.string(),
  src: z.string().optional(),
  scm: z.string().optional(),
  version: z.string().optional(),
});
export type GalaxyRoleRequirement = z.infer<typeof galaxyRoleRequirementSchema>;

export const galaxyCollectionRequirementSchema = z.object({
  name: z.string(),
  source: z.string().optional(),
  version: z.string().optional(),
});
export type GalaxyCollectionRequirement = z.infer<typeof galaxyCollectionRequirementSchema>;

/** Exactly one of inline/configMapRef/git must be set — enforced via CEL, see gen/crd-yaml.ts. */
export const playbookSourceSchema = z.object({
  inline: z.object({ playbook: z.string().max(262_144) }).optional(),
  configMapRef: configMapKeyRefSchema.optional(),
  git: z
    .object({
      url: z.string(),
      revision: z.string().optional(),
      path: z.string().optional(),
      /** SSH auth (for `git@host:...`/`ssh://` URLs) — Secret with an `ssh-privatekey` key, same convention as AnsibleSSHKey. */
      sshKeySecretRef: secretKeyRefSchema.omit({ key: true }).optional(),
      /** HTTP Basic Auth (for `https://` URLs) — Secret with `username`/`password` keys, the same shape as the built-in `kubernetes.io/basic-auth` Secret type (a personal access token works as the password). */
      basicAuthSecretRef: secretKeyRefSchema.omit({ key: true }).optional(),
    })
    .optional(),
});
export type PlaybookSource = z.infer<typeof playbookSourceSchema>;

export const PLAYBOOK_SOURCE_CEL =
  '(has(self.inline)?1:0) + (has(self.configMapRef)?1:0) + (has(self.git)?1:0) == 1';
export const PLAYBOOK_SOURCE_CEL_MESSAGE =
  'exactly one of source.inline, source.configMapRef, source.git must be set';

/** A git source needs at most one auth method — public repos need neither. */
export const GIT_AUTH_CEL =
  '(has(self.sshKeySecretRef)?1:0) + (has(self.basicAuthSecretRef)?1:0) <= 1';
export const GIT_AUTH_CEL_MESSAGE =
  'at most one of source.git.sshKeySecretRef or source.git.basicAuthSecretRef may be set';

export const ansiblePlaybookSpecSchema = z.object({
  source: playbookSourceSchema,
  entryPoint: z.string().optional(),
  dependencies: z
    .object({
      roles: z.array(galaxyRoleRequirementSchema).optional(),
      collections: z.array(galaxyCollectionRequirementSchema).optional(),
    })
    .optional(),
  extraVars: z.record(z.string(), z.unknown()).optional(),
});
export type AnsiblePlaybookSpec = z.infer<typeof ansiblePlaybookSpecSchema>;

export const ansiblePlaybookStatusSchema = z.object(commonStatusFields);
export type AnsiblePlaybookStatus = z.infer<typeof ansiblePlaybookStatusSchema>;

export const clusterAnsiblePlaybookSpecSchema = ansiblePlaybookSpecSchema;
export const clusterAnsiblePlaybookStatusSchema = ansiblePlaybookStatusSchema;
