import { describe, expect, test } from 'bun:test';
import type { ResolvedGroup } from '@a5e/k8s-client';
import { limitForHostNames, shardHosts } from './host-sharding';
import { type JobBuildInput, buildJobSpec } from './job-builder';

function input(overrides: Partial<JobBuildInput> = {}): JobBuildInput {
  return {
    runName: 'run1',
    runUid: 'uid1',
    namespace: 'team-a',
    runnerImage: 'runner:latest',
    inventoryConfigMapName: 'inv',
    playbookConfigMapName: 'pb',
    extraVarsConfigMapName: 'vars',
    entryPoint: 'playbook.yml',
    hasDependencies: false,
    sshKeyMounts: [],
    ...overrides,
  };
}

function mainArgs(spec: ReturnType<typeof buildJobSpec>): string[] {
  const container = spec.spec!.template.spec!.containers.find(
    (c) => c.name === 'ansible-playbook',
  )!;
  return container.args!;
}

describe('ansible options become one argv entry each', () => {
  // Regression: these used to be joined into a single ANSIBLE_EXTRA_ARGS string that the
  // entrypoint re-split on spaces — so a value containing a space split in the wrong place, and
  // a user could smuggle extra ansible-playbook flags in through any of these fields.
  test('a tag containing a space stays one argument', () => {
    const args = mainArgs(buildJobSpec(input({ ansibleOptions: { tags: ['deploy web'] } })));
    expect(args).toEqual(['playbook', '--tags', 'deploy web']);
  });

  test('an injected flag stays an opaque value, not a separate flag', () => {
    const args = mainArgs(
      buildJobSpec(input({ ansibleOptions: { limit: 'all -e ansible_connection=local' } })),
    );
    expect(args).toEqual(['playbook', '--limit', 'all -e ansible_connection=local']);
  });

  test('no options means no extra arguments', () => {
    expect(mainArgs(buildJobSpec(input()))).toEqual(['playbook']);
  });

  test('an empty limit emits no --limit flag at all', () => {
    // This is the hazard the parallel-shard path must guard against before building a Job:
    // an empty limit silently widens the run to the whole inventory.
    expect(mainArgs(buildJobSpec(input({ ansibleOptions: { limit: '' } })))).toEqual(['playbook']);
  });
});

describe('re-deriving a queued shard’s limit', () => {
  const groups = (names: string[]): ResolvedGroup[] => [
    {
      name: 'all',
      hosts: names.map((name) => ({ kind: 'AnsibleHost', namespace: 'team-a', name, spec: {} })),
    } as unknown as ResolvedGroup,
  ];

  test('keeps only hosts that still resolve', () => {
    expect(limitForHostNames(groups(['a', 'b', 'c']), ['a', 'c'])).toBe('a:c');
  });

  // Regression: every host of a still-queued shard being deleted used to yield '', which
  // buildJobSpec then dropped — running the playbook against the FULL inventory. The caller
  // (run-controller's pollParallelRun) now treats '' as "nothing left to do".
  test('returns empty when every host has left the inventory', () => {
    expect(limitForHostNames(groups(['x']), ['a', 'c'])).toBe('');
  });

  test('shardHosts never produces an empty limit', () => {
    const shards = shardHosts(groups(['a', 'b', 'c']), 2);
    expect(shards.map((s) => s.limit)).toEqual(['a:b', 'c']);
  });
});
