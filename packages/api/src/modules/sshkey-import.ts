import { generateKeyPairSync } from 'node:crypto';
import { API_GROUP_VERSION, RESOURCE_DESCRIPTORS_BY_KIND } from '@a5e/schemas';
import sshpk from 'sshpk';
import { authorize } from '../auth/authorize';
import { extractBearerToken } from '../auth/session';
import type { AnyElysia } from '../lib/elysia-types';
import { client, coreApi, impersonatedOptions } from '../plugins/k8s';

interface ImportBody {
  name: string;
  mode: 'generate' | 'upload';
  keyType?: 'ed25519' | 'rsa';
  /** Required for mode "upload" — raw PEM/OpenSSH private key text. */
  privateKey?: string;
  /** Optional passphrase — for "upload", the existing key's passphrase; unused for "generate" (freshly generated keys are left unencrypted, they're single-purpose and already access-controlled via the Secret). */
  passphrase?: string;
}

/** Generates a fresh keypair and returns it already in OpenSSH private-key wire format (what ssh/ansible expect), via Node's own keygen + sshpk's format conversion (no ssh-keygen binary needed). */
function generateOpenSshPrivateKey(keyType: 'ed25519' | 'rsa'): string {
  const { privateKey } =
    keyType === 'rsa'
      ? generateKeyPairSync('rsa', {
          modulusLength: 4096,
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
          publicKeyEncoding: { type: 'spki', format: 'pem' },
        })
      : generateKeyPairSync('ed25519', {
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
          publicKeyEncoding: { type: 'spki', format: 'pem' },
        });
  return sshpk.parsePrivateKey(privateKey, 'pkcs8').toBuffer('openssh').toString('utf8');
}

async function resolvePrivateKeyContent(
  body: ImportBody,
): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  if (body.mode === 'generate') {
    return { ok: true, content: generateOpenSshPrivateKey(body.keyType ?? 'ed25519') };
  }
  if (!body.privateKey) {
    return { ok: false, error: 'privateKey is required for mode "upload"' };
  }
  try {
    // Validate it actually parses (and that the passphrase, if any, is correct) before we ever
    // write it into a Secret — surfaces a clear error instead of a silently-broken AnsibleSSHKey.
    sshpk.parsePrivateKey(
      body.privateKey,
      'auto',
      body.passphrase ? { passphrase: body.passphrase } : undefined,
    );
  } catch (err) {
    return { ok: false, error: `could not parse private key: ${(err as Error).message}` };
  }
  return { ok: true, content: body.privateKey };
}

function secretData(
  privateKeyContent: string,
  passphrase: string | undefined,
): Record<string, string> {
  const data: Record<string, string> = {
    'ssh-privatekey': Buffer.from(privateKeyContent).toString('base64'),
  };
  if (passphrase) data.passphrase = Buffer.from(passphrase).toString('base64');
  return data;
}

/**
 * Convenience routes backing the UI's "Generate" / "Upload a file" SSH key creation modes (the
 * plain create route already covers "reference an existing Secret"). Creates the Secret and the
 * AnsibleSSHKey/ClusterAnsibleSSHKey in one call, both impersonated as the calling user — same
 * as every other CRUD path, so authorization is real RBAC, not API-side logic.
 */
export function registerSSHKeyImportRoutes(app: AnyElysia): AnyElysia {
  return app
    .post(
      '/api/v1/namespaces/:namespace/ansiblesshkeys/import',
      async ({ params, body, headers, set }) => {
        const auth = await authorize(extractBearerToken(headers), 'user');
        if (auth instanceof Response) return auth;
        const { session } = auth;
        const importBody = body as ImportBody;

        const resolved = await resolvePrivateKeyContent(importBody);
        if (!resolved.ok) {
          set.status = 400;
          return { error: resolved.error };
        }

        await coreApi.createNamespacedSecret(
          {
            namespace: params.namespace,
            body: {
              metadata: { name: importBody.name },
              type: 'kubernetes.io/ssh-auth',
              data: secretData(resolved.content, importBody.passphrase),
            },
          },
          impersonatedOptions(session.identity),
        );

        set.status = 201;
        return client.create(
          RESOURCE_DESCRIPTORS_BY_KIND.AnsibleSSHKey!,
          {
            apiVersion: API_GROUP_VERSION,
            kind: 'AnsibleSSHKey',
            metadata: { name: importBody.name, namespace: params.namespace },
            spec: {
              secretRef: { name: importBody.name, key: 'ssh-privatekey' },
              ...(importBody.passphrase
                ? { passphraseSecretRef: { name: importBody.name, key: 'passphrase' } }
                : {}),
            },
          },
          session.identity,
          params.namespace,
        );
      },
    )

    .post('/api/v1/clusteransiblesshkeys/import', async ({ body, headers, set }) => {
      const auth = await authorize(extractBearerToken(headers), 'user');
      if (auth instanceof Response) return auth;
      const { session } = auth;
      const importBody = body as ImportBody & { secretNamespace: string };
      if (!importBody.secretNamespace) {
        set.status = 400;
        return {
          error:
            'secretNamespace is required for a ClusterAnsibleSSHKey (no owning namespace to default to)',
        };
      }

      const resolved = await resolvePrivateKeyContent(importBody);
      if (!resolved.ok) {
        set.status = 400;
        return { error: resolved.error };
      }

      await coreApi.createNamespacedSecret(
        {
          namespace: importBody.secretNamespace,
          body: {
            metadata: { name: importBody.name },
            type: 'kubernetes.io/ssh-auth',
            data: secretData(resolved.content, importBody.passphrase),
          },
        },
        impersonatedOptions(session.identity),
      );

      set.status = 201;
      return client.create(
        RESOURCE_DESCRIPTORS_BY_KIND.ClusterAnsibleSSHKey!,
        {
          apiVersion: API_GROUP_VERSION,
          kind: 'ClusterAnsibleSSHKey',
          metadata: { name: importBody.name },
          spec: {
            secretRef: {
              name: importBody.name,
              namespace: importBody.secretNamespace,
              key: 'ssh-privatekey',
            },
            ...(importBody.passphrase
              ? {
                  passphraseSecretRef: {
                    name: importBody.name,
                    namespace: importBody.secretNamespace,
                    key: 'passphrase',
                  },
                }
              : {}),
          },
        },
        session.identity,
      );
    });
}
