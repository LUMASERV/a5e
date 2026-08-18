import sshpk from 'sshpk';
import { resolveRefNamespace, type CustomResourceClient } from '@a5e/k8s-client';
import type {
  AnsibleSSHKeySpec,
  AnsibleSSHKeyStatus,
  ClusterAnsibleSSHKeySpec,
  CustomResource,
  ResourceDescriptor,
} from '@a5e/schemas';
import type { CoreResources } from '../k8s/core';
import { patchReadyCondition } from './base-reconciler';

function decodeSecretValue(data: Record<string, string> | undefined, key: string): Buffer | undefined {
  const value = data?.[key];
  return value ? Buffer.from(value, 'base64') : undefined;
}

/**
 * Derives and publishes the SSH public key from the referenced Secret's private key (plan §2.4).
 * Reconciles on spec changes (via the normal watch) plus the controller's periodic full resync —
 * deliberately does NOT watch/list Secrets cluster-wide (that would force caching every Secret in
 * the cluster in memory); it only ever does a targeted `get` for the one Secret this object names.
 */
export async function reconcileSSHKey(
  client: CustomResourceClient,
  core: CoreResources,
  descriptor: ResourceDescriptor,
  obj: CustomResource<AnsibleSSHKeySpec | ClusterAnsibleSSHKeySpec, AnsibleSSHKeyStatus>,
): Promise<void> {
  const { secretRef, passphraseSecretRef } = obj.spec;
  // A namespaced AnsibleSSHKey/ClusterAnsibleSSHKey must never be allowed to point secretRef at a
  // foreign namespace either — deriving/publishing a public key+fingerprint from a Secret the
  // requesting user has no RBAC on is itself a read-confirmation oracle, even short of the full
  // private-key exfiltration this rule also blocks in run-controller.ts.
  const ownerNamespace = descriptor.scope === 'Namespaced' ? obj.metadata.namespace : undefined;
  let namespace: string | undefined;
  try {
    namespace = resolveRefNamespace('Namespaced', secretRef.namespace, ownerNamespace);
  } catch (err) {
    await patchReadyCondition(client, descriptor, obj, false, 'SecretNotFound', (err as Error).message);
    return;
  }
  if (!namespace) {
    await patchReadyCondition(client, descriptor, obj, false, 'SecretNotFound', 'no namespace resolvable for secretRef');
    return;
  }

  let secret: Awaited<ReturnType<CoreResources['getSecret']>>;
  try {
    secret = await core.getSecret(namespace, secretRef.name);
  } catch {
    await patchReadyCondition(
      client,
      descriptor,
      obj,
      false,
      'SecretNotFound',
      `Secret ${namespace}/${secretRef.name} not found`,
    );
    return;
  }

  const keyData = decodeSecretValue(secret.data, secretRef.key ?? 'ssh-privatekey');
  if (!keyData) {
    await patchReadyCondition(
      client,
      descriptor,
      obj,
      false,
      'InvalidKeyFormat',
      `Secret ${namespace}/${secretRef.name} has no key "${secretRef.key ?? 'ssh-privatekey'}"`,
    );
    return;
  }

  let passphrase: string | undefined;
  if (passphraseSecretRef) {
    let passphraseNamespace: string | undefined;
    try {
      passphraseNamespace = resolveRefNamespace('Namespaced', passphraseSecretRef.namespace, ownerNamespace);
    } catch (err) {
      await patchReadyCondition(client, descriptor, obj, false, 'SecretNotFound', (err as Error).message);
      return;
    }
    if (passphraseNamespace) {
      try {
        const passphraseSecret = await core.getSecret(passphraseNamespace, passphraseSecretRef.name);
        const raw = decodeSecretValue(passphraseSecret.data, passphraseSecretRef.key ?? 'passphrase');
        passphrase = raw?.toString('utf8');
      } catch {
        await patchReadyCondition(
          client,
          descriptor,
          obj,
          false,
          'SecretNotFound',
          `passphraseSecretRef ${passphraseNamespace}/${passphraseSecretRef.name} not found`,
        );
        return;
      }
    }
  }

  let privateKey: sshpk.PrivateKey;
  try {
    privateKey = sshpk.parsePrivateKey(keyData, 'auto', passphrase ? { passphrase } : undefined);
  } catch (err) {
    await patchReadyCondition(
      client,
      descriptor,
      obj,
      false,
      'InvalidKeyFormat',
      `could not parse private key: ${(err as Error).message}`,
    );
    return;
  }

  const publicKey = privateKey.toPublic();
  const status: AnsibleSSHKeyStatus = {
    publicKey: publicKey.toString('ssh'),
    fingerprint: publicKey.fingerprint('sha256').toString(),
    keyType: normalizeKeyType(privateKey.type),
    observedGeneration: obj.metadata.generation,
  };
  await client.patchStatus(descriptor, obj.metadata.name, status, 'self', obj.metadata.namespace);
  await patchReadyCondition(client, descriptor, { ...obj, status }, true, 'Ready', 'public key derived');
}

function normalizeKeyType(type: string): AnsibleSSHKeyStatus['keyType'] {
  if (type === 'rsa' || type === 'ed25519' || type === 'ecdsa') return type;
  return undefined;
}
