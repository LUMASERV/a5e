import { describe, expect, test } from 'bun:test';
import type { ChangeItem, Permission } from '@a5e/schemas';
import { canAct } from '../auth/permission-engine';
import { approvalTargets, authNamespace } from './change-requests';

function grant(p: Partial<Permission>): Permission {
  return { type: '*', namespaces: [], actions: ['*'], ...p } as Permission;
}

function labelled(labels: Record<string, string> | null) {
  return { metadata: { labels } };
}

describe('authNamespace comes from the descriptor, not the request', () => {
  // Regression: the change-item schema accepts a namespace on ANY item, but the k8s client
  // ignores it for a cluster-scoped kind and acts on the cluster-wide object. Authorizing against
  // the requester's namespace let a staged ClusterAnsibleHost delete carry `namespace: 'team-a'`,
  // satisfy a team-a-only approve grant, and then delete the cluster object.
  test('a cluster-scoped item ignores a requester-supplied namespace', () => {
    const item = {
      action: 'delete',
      type: 'ClusterAnsibleHost',
      name: 'h1',
      namespace: 'team-a',
    } as ChangeItem;
    expect(authNamespace(item)).toBeUndefined();
  });

  test('a namespaced item keeps its namespace', () => {
    const item = { action: 'delete', type: 'AnsibleHost', name: 'h1', namespace: 'team-a' };
    expect(authNamespace(item as ChangeItem)).toBe('team-a');
  });

  test('a team-a grant no longer reaches a cluster-scoped delete', async () => {
    const teamA = grant({ namespaces: ['team-a'] });
    const changes = [
      { action: 'create', type: 'ClusterAnsibleHost', name: 'h1', body: labelled({}) },
      { action: 'delete', type: 'ClusterAnsibleHost', name: 'h1', namespace: 'team-a' },
    ] as ChangeItem[];
    const perItem = await approvalTargets(changes);
    expect(perItem[1]!.every((t) => canAct([teamA], t, 'approve'))).toBe(false);
  });
});

describe('repeated edits of one object are checked in apply order', () => {
  // Regression: every item used to be checked against the object's live labels, so two patches
  // could each look fine on their own yet leave the object outside every grant once applied in
  // sequence. Starting from {env: dev, team: a} with grants for `env=dev` OR `team=a`, a patch to
  // `env=prod` and a patch to `team=b` both pass individually, but together produce
  // {env: prod, team: b}, which matches neither.
  const grants = [
    grant({ labelSelector: { matchLabels: { env: 'dev' } } }),
    grant({ labelSelector: { matchLabels: { team: 'a' } } }),
  ];
  // A create in the same request seeds the projection, so no live lookup is needed here.
  const changes = [
    {
      action: 'create',
      type: 'AnsibleHost',
      name: 'h1',
      namespace: 'team-a',
      body: labelled({ env: 'dev', team: 'a' }),
    },
    {
      action: 'update',
      type: 'AnsibleHost',
      name: 'h1',
      namespace: 'team-a',
      body: labelled({ env: 'prod' }),
    },
    {
      action: 'update',
      type: 'AnsibleHost',
      name: 'h1',
      namespace: 'team-a',
      body: labelled({ team: 'b' }),
    },
  ] as ChangeItem[];

  test('the second patch is checked against what the first one left behind', async () => {
    const perItem = await approvalTargets(changes);
    expect(perItem[2]!.map((t) => t.labels)).toEqual([
      { env: 'prod', team: 'a' },
      { env: 'prod', team: 'b' },
    ]);
  });

  test('the combined escape is denied', async () => {
    const perItem = await approvalTargets(changes);
    const denied = perItem.flatMap((targets, i) =>
      targets.every((t) => canAct(grants, t, 'approve')) ? [] : [i],
    );
    expect(denied).toEqual([2]);
  });

  test('a single in-grant edit is still allowed', async () => {
    const perItem = await approvalTargets(changes.slice(0, 2));
    expect(perItem.every((targets) => targets.every((t) => canAct(grants, t, 'approve')))).toBe(
      true,
    );
  });
});
