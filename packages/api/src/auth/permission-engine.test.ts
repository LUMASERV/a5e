import { describe, expect, test } from 'bun:test';
import { RESOURCE_DESCRIPTORS_BY_KIND } from '@a5e/schemas';
import type { Permission } from '@a5e/schemas';
import { canAct, mergedLabelsAfterPatch, planList } from './permission-engine';

const clusterHost = RESOURCE_DESCRIPTORS_BY_KIND.ClusterAnsibleHost!;
const host = RESOURCE_DESCRIPTORS_BY_KIND.AnsibleHost!;

function grant(p: Partial<Permission>): Permission {
  return { type: '*', namespaces: [], actions: ['*'], ...p } as Permission;
}

describe('a namespace-restricted grant does not reach cluster-scoped kinds', () => {
  // Regression: `namespaceMatches` used to return true whenever the target had no namespace,
  // so a grant an admin wrote as "team-a only" silently carried full access to every
  // cluster-scoped object in the cluster.
  const teamA = grant({ namespaces: ['team-a'] });

  test('canAct denies a cluster-scoped target', () => {
    expect(canAct([teamA], { type: 'ClusterAnsibleHost' }, 'delete')).toBe(false);
  });

  test('canAct still allows the namespace it names, and denies others', () => {
    expect(canAct([teamA], { type: 'AnsibleHost', namespace: 'team-a' }, 'delete')).toBe(true);
    expect(canAct([teamA], { type: 'AnsibleHost', namespace: 'team-b' }, 'delete')).toBe(false);
  });

  test('planList denies listing a cluster-scoped kind', () => {
    expect(planList([teamA], clusterHost, 'list', undefined).mode).toBe('denied');
  });

  test('an unrestricted grant still reaches both scopes', () => {
    const any = grant({});
    expect(canAct([any], { type: 'ClusterAnsibleHost' }, 'delete')).toBe(true);
    expect(planList([any], clusterHost, 'list', undefined).mode).toBe('list');
    expect(planList([any], host, 'list', 'team-b').mode).toBe('list');
  });
});

describe('label selectors', () => {
  const devOnly = grant({ labelSelector: { matchLabels: { env: 'dev' } } });
  const notProd = grant({
    labelSelector: { matchExpressions: [{ key: 'env', operator: 'NotIn', values: ['prod'] }] },
  });

  test('matches only objects carrying the label', () => {
    expect(canAct([devOnly], { type: 'AnsibleHost', labels: { env: 'dev' } }, 'approve')).toBe(
      true,
    );
    expect(canAct([devOnly], { type: 'AnsibleHost', labels: { env: 'prod' } }, 'approve')).toBe(
      false,
    );
  });

  // Why ChangeRequest approval must read labels off the live object, never off the staged body:
  // a `delete` item carries no body at all, and a "anything but prod" grant matches an object
  // whose labels are unknown. Reading the real labels is what makes these two disagree.
  test('an absent label set slips past a NotIn grant', () => {
    expect(canAct([notProd], { type: 'AnsibleHost', labels: undefined }, 'approve')).toBe(true);
    expect(canAct([notProd], { type: 'AnsibleHost', labels: { env: 'prod' } }, 'approve')).toBe(
      false,
    );
  });
});

describe('mergedLabelsAfterPatch', () => {
  const current = { env: 'dev', team: 'a' };

  test('a patch that does not mention labels leaves them alone', () => {
    expect(mergedLabelsAfterPatch(current, { spec: { enabled: false } })).toEqual(current);
  });

  test('a per-key null removes just that key', () => {
    expect(mergedLabelsAfterPatch(current, { metadata: { labels: { team: null } } })).toEqual({
      env: 'dev',
    });
  });

  // Regression: `labels: null` removes the whole map (RFC 7396), but this used to return the
  // CURRENT labels — so an env=dev approver could approve a patch that stripped every label and
  // moved the object outside their own grant.
  test('a null labels field clears every label', () => {
    expect(mergedLabelsAfterPatch(current, { metadata: { labels: null } })).toEqual({});
  });

  test('clearing every label escapes a label-scoped grant', () => {
    const devOnly = grant({ labelSelector: { matchLabels: { env: 'dev' } } });
    const after = mergedLabelsAfterPatch(current, { metadata: { labels: null } });
    expect(canAct([devOnly], { type: 'AnsibleHost', labels: current }, 'approve')).toBe(true);
    expect(canAct([devOnly], { type: 'AnsibleHost', labels: after }, 'approve')).toBe(false);
  });
});
