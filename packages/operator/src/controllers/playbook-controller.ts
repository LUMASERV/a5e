import { resolveRefNamespace, type CustomResourceClient } from '@a5e/k8s-client';
import type { AnsiblePlaybookSpec, AnsiblePlaybookStatus, CustomResource, ResourceDescriptor } from '@a5e/schemas';
import type { CoreResources } from '../k8s/core';
import { patchReadyCondition } from './base-reconciler';

/**
 * Validates that the playbook's source actually resolves (ConfigMap exists, or a referenced git
 * auth Secret exists) so a bad reference surfaces via `kubectl describe` instead of only at
 * AnsibleRun time. `inline` sources need no external check. Deliberately does not validate git
 * connectivity itself (would require a network call on every reconcile) — that failure surfaces
 * naturally when an AnsibleRun's fetch-content init container fails (plan §2.5's `resolvedRevision`
 * is intentionally per-run, not per-playbook, for exactly this reason).
 */
export async function reconcilePlaybook(
  client: CustomResourceClient,
  core: CoreResources,
  descriptor: ResourceDescriptor,
  obj: CustomResource<AnsiblePlaybookSpec, AnsiblePlaybookStatus>,
): Promise<void> {
  const { source } = obj.spec;
  // A namespaced AnsiblePlaybook/ClusterAnsiblePlaybook must never be allowed to point its own
  // configMapRef/git auth secretRef at a foreign namespace either — even an existence-only check
  // is a cross-namespace oracle (an attacker can probe whether a guessed-name Secret/ConfigMap
  // exists elsewhere by watching this object's Ready condition), and it's the same underlying
  // rule as the fuller exfiltration paths this closes in run-controller.ts/sshkey-controller.ts.
  const ownerNamespace = descriptor.scope === 'Namespaced' ? obj.metadata.namespace : undefined;

  if (source.configMapRef) {
    let namespace: string | undefined;
    try {
      namespace = resolveRefNamespace('Namespaced', source.configMapRef.namespace, ownerNamespace);
    } catch (err) {
      await patchReadyCondition(client, descriptor, obj, false, 'ConfigMapNotFound', (err as Error).message);
      return;
    }
    if (!namespace) {
      await patchReadyCondition(client, descriptor, obj, false, 'ConfigMapNotFound', 'no namespace resolvable for source.configMapRef');
      return;
    }
    try {
      await core.getConfigMap(namespace, source.configMapRef.name);
    } catch {
      await patchReadyCondition(
        client,
        descriptor,
        obj,
        false,
        'ConfigMapNotFound',
        `ConfigMap ${namespace}/${source.configMapRef.name} not found`,
      );
      return;
    }
  }

  const gitAuthRef = source.git?.sshKeySecretRef ?? source.git?.basicAuthSecretRef;
  if (gitAuthRef) {
    let namespace: string | undefined;
    try {
      namespace = resolveRefNamespace('Namespaced', gitAuthRef.namespace, ownerNamespace);
    } catch (err) {
      await patchReadyCondition(client, descriptor, obj, false, 'SecretNotFound', (err as Error).message);
      return;
    }
    if (!namespace) {
      await patchReadyCondition(client, descriptor, obj, false, 'SecretNotFound', 'no namespace resolvable for source.git auth secretRef');
      return;
    }
    try {
      await core.getSecret(namespace, gitAuthRef.name);
    } catch {
      await patchReadyCondition(
        client,
        descriptor,
        obj,
        false,
        'SecretNotFound',
        `Secret ${namespace}/${gitAuthRef.name} not found`,
      );
      return;
    }
  }

  await patchReadyCondition(client, descriptor, obj, true, 'Ready', 'playbook source resolves');
}
