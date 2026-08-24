#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
/**
 * Local dev convenience script (plan §6): seeds a sample AnsibleHost, AnsibleInventory, an
 * inline "hello world" AnsiblePlaybook, and an AnsibleSSHKey (from a throwaway generated
 * keypair) so there's data to click through immediately — and provisions a ServiceAccount
 * token for running the operator/API locally under Bun.
 *
 * Shells out to `kubectl`/`ssh-keygen` rather than using @a5e/k8s-client directly: this
 * script only needs to work against whatever kubeconfig is already active (often OrbStack's
 * default mTLS one), and kubectl itself has no trouble with that — only our own Bun code does
 * (see packages/k8s-client/src/bootstrap.ts). Keeping this script kubectl-based sidesteps that
 * entirely.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { API_GROUP_VERSION } from '@a5e/schemas';

// Persistent (gitignored) location for the extracted cluster CA — a tmpdir would get cleaned
// up before the printed `export NODE_EXTRA_CA_CERTS=...` instructions could ever be used.
const CA_FILE = join(dirname(import.meta.dir), '.dev-cluster-ca.crt');

const NAMESPACE = process.env.SEED_NAMESPACE ?? 'default';
const SERVER = process.env.SEED_SERVER ?? 'https://127.0.0.1:26443';

function run(cmd: string, args: string[], input?: string): string {
  const result = spawnSync(cmd, args, { input, encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(result.stderr);
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${result.status})`);
  }
  return result.stdout;
}

function kubectlApply(yaml: string) {
  run('kubectl', ['apply', '-f', '-'], yaml);
}

console.log(`Seeding fixtures into namespace "${NAMESPACE}"...`);

// 1. Dev ServiceAccount + token, for running the operator/API locally under Bun (bearer-token
//    auth works under Bun; the default kubeconfig's mTLS often doesn't — see bootstrap.ts).
kubectlApply(`
apiVersion: v1
kind: ServiceAccount
metadata: { name: a5e-dev, namespace: ${NAMESPACE} }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: a5e-dev-admin }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: cluster-admin }
subjects: [{ kind: ServiceAccount, name: a5e-dev, namespace: ${NAMESPACE} }]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: a5e-dev-impersonate-user }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: cluster-admin }
subjects: [{ kind: User, name: dev@local }]
`);
const token = run('kubectl', [
  'create',
  'token',
  'a5e-dev',
  '-n',
  NAMESPACE,
  '--duration=24h',
]).trim();
const caData = run('kubectl', [
  'config',
  'view',
  '--minify',
  '--raw',
  '-o',
  'jsonpath={.clusters[0].cluster.certificate-authority-data}',
]).trim();
await Bun.write(CA_FILE, Buffer.from(caData, 'base64'));

// 2. Throwaway SSH keypair + Secret.
const tmpDir = mkdtempSync(join(tmpdir(), 'a5e-seed-'));
const keyFile = join(tmpDir, 'id_ed25519');
run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyFile, '-q']);
const privateKeyB64 = Buffer.from(readFileSync(keyFile)).toString('base64');
kubectlApply(`
apiVersion: v1
kind: Secret
metadata: { name: seed-ssh-key, namespace: ${NAMESPACE} }
type: kubernetes.io/ssh-auth
data: { ssh-privatekey: ${privateKeyB64} }
`);

// 3. Fixtures: AnsibleSSHKey, AnsibleHost, AnsiblePlaybook (inline), AnsibleInventory.
kubectlApply(`
apiVersion: ${API_GROUP_VERSION}
kind: AnsibleSSHKey
metadata: { name: seed-key, namespace: ${NAMESPACE} }
spec: { secretRef: { name: seed-ssh-key } }
---
apiVersion: ${API_GROUP_VERSION}
kind: AnsibleHost
metadata:
  name: seed-localhost
  namespace: ${NAMESPACE}
  labels: { role: seed }
spec: { ansibleAddress: "127.0.0.1" }
---
apiVersion: ${API_GROUP_VERSION}
kind: AnsiblePlaybook
metadata: { name: seed-hello, namespace: ${NAMESPACE} }
spec:
  source:
    inline:
      playbook: |
        - hosts: all
          gather_facts: false
          tasks:
            - debug:
                msg: "hello from a5e, {{ inventory_hostname }}"
---
apiVersion: ${API_GROUP_VERSION}
kind: AnsibleInventory
metadata: { name: seed-inventory, namespace: ${NAMESPACE} }
spec:
  groups:
    - name: web
      hostSources:
        - kind: AnsibleHost
          labelSelector: { matchLabels: { role: seed } }
`);

rmSync(tmpDir, { recursive: true, force: true });

console.log(`
Fixtures created in namespace "${NAMESPACE}":
  AnsibleSSHKey/seed-key, AnsibleHost/seed-localhost, AnsiblePlaybook/seed-hello, AnsibleInventory/seed-inventory

To run the operator/API locally under Bun against this cluster, export (this token lasts 24h):

  export NODE_EXTRA_CA_CERTS="${CA_FILE}"
  export OPERATOR_KUBE_SERVER="${SERVER}"
  export OPERATOR_KUBE_TOKEN="${token}"
  export OPERATOR_KUBE_CA_FILE="${CA_FILE}"
  # API_KUBE_SERVER / API_KUBE_TOKEN / API_KUBE_CA_FILE mirror the OPERATOR_KUBE_* ones above,
  # for running packages/api the same way.

First run, also set BOOTSTRAP_ADMIN_USERNAME/BOOTSTRAP_ADMIN_PASSWORD for the API to create your
first local admin login (see auth/bootstrap.ts) — safe to leave set, it only ever fires once:
  bun run dev:operator
  bun run dev:api
  bun run dev:ui
`);
