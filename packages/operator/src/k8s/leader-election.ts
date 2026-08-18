import * as k8s from '@kubernetes/client-node';

/**
 * `@kubernetes/client-node` v2 ships no leader-election helper at all (checked — no
 * LeaderElector/leader_election module exists in this version, unlike older 0.x/1.x releases).
 * This is a minimal from-scratch Lease-based (`coordination.k8s.io/v1`) implementation of the
 * same algorithm client-go's LeaderElector uses: acquire-or-renew a Lease via optimistic
 * concurrency, step down (and let the process exit so k8s restarts it cleanly) if a renew is
 * ever lost. Included in v1 per plan §3.2 — without it, an accidental multi-replica window could
 * have two operators both create a Job for the same AnsibleRun, a correctness bug against real
 * infrastructure, not just wasted work.
 */
export interface LeaderElectionOptions {
  leaseName: string;
  namespace: string;
  identity: string;
  leaseDurationSeconds?: number;
  retryPeriodMs?: number;
}

export async function runWithLeaderElection(
  kc: k8s.KubeConfig,
  options: LeaderElectionOptions,
  onStartedLeading: () => Promise<void>,
): Promise<void> {
  const api = kc.makeApiClient(k8s.CoordinationV1Api);
  const leaseDurationSeconds = options.leaseDurationSeconds ?? 15;
  const retryPeriodMs = options.retryPeriodMs ?? 2000;

  let leading = false;

  async function tryAcquireOrRenew(): Promise<boolean> {
    let lease: k8s.V1Lease;
    try {
      lease = await api.readNamespacedLease({ name: options.leaseName, namespace: options.namespace });
    } catch (err) {
      if ((err as { code?: number }).code === 404) {
        try {
          await api.createNamespacedLease({
            namespace: options.namespace,
            body: {
              metadata: { name: options.leaseName, namespace: options.namespace },
              spec: {
                holderIdentity: options.identity,
                leaseDurationSeconds,
                acquireTime: new k8s.V1MicroTime(),
                renewTime: new k8s.V1MicroTime(),
                leaseTransitions: 1,
              },
            },
          });
          return true;
        } catch {
          return false; // lost the race to create it
        }
      }
      throw err;
    }

    const spec = lease.spec ?? {};
    const renewTimeMs = spec.renewTime ? new Date(spec.renewTime).getTime() : 0;
    const expired = Date.now() - renewTimeMs > leaseDurationSeconds * 1000;
    const heldByUs = spec.holderIdentity === options.identity;

    if (!heldByUs && !expired) return false;

    try {
      await api.replaceNamespacedLease({
        name: options.leaseName,
        namespace: options.namespace,
        body: {
          ...lease,
          spec: {
            ...spec,
            holderIdentity: options.identity,
            leaseDurationSeconds,
            renewTime: new k8s.V1MicroTime(),
            acquireTime: heldByUs ? spec.acquireTime : new k8s.V1MicroTime(),
            leaseTransitions: heldByUs ? spec.leaseTransitions : (spec.leaseTransitions ?? 0) + 1,
          },
        },
      });
      return true;
    } catch {
      return false; // lost the optimistic-concurrency race to another replica
    }
  }

  for (;;) {
    const acquired = await tryAcquireOrRenew().catch((err) => {
      console.error('leader election: lease read/write failed', err);
      return false;
    });

    if (acquired && !leading) {
      leading = true;
      console.log(`leader election: acquired lease "${options.leaseName}" as ${options.identity}`);
      onStartedLeading().catch((err) => {
        console.error('onStartedLeading failed — exiting so this pod restarts cleanly', err);
        process.exit(1);
      });
    } else if (!acquired && leading) {
      console.error('leader election: lost the lease — exiting so this pod restarts cleanly');
      process.exit(1);
    }

    await new Promise((resolve) => setTimeout(resolve, retryPeriodMs));
  }
}
