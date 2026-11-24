import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoStep } from '../__tests__/helpers/migration.mts';
import { fromVersion, planSteps } from './plan.mts';
import { MIGRATION_BASELINE } from './steps.mts';

const ids = (steps: { id: string }[]): string[] => steps.map((step) => step.id);

test('planSteps selects the steps with from < since <= to, in version order, ties in registry order', () => {
  const registry = [
    autoStep('c', '0.40.0'),
    autoStep('a', '0.38.0'),
    autoStep('d', '0.40.0'),
    autoStep('b', '0.39.0'),
    autoStep('e', '0.41.0'),
  ];
  const cases: { name: string; registry: typeof registry; from: string; to: string; expected: string[] }[] = [
    { name: 'empty registry', registry: [], from: '0.37.0', to: '0.40.0', expected: [] },
    { name: 'one step in range', registry: [registry[1]!], from: '0.37.0', to: '0.38.0', expected: ['a'] },
    {
      name: 'several versions in order, ties kept',
      registry,
      from: '0.37.0',
      to: '0.40.0',
      expected: ['a', 'b', 'c', 'd'],
    },
    { name: 'since equal to from is excluded', registry, from: '0.38.0', to: '0.40.0', expected: ['b', 'c', 'd'] },
    { name: 'since equal to to is included', registry, from: '0.39.0', to: '0.40.0', expected: ['c', 'd'] },
    { name: 'a later version than to is left out', registry, from: '0.40.0', to: '0.40.0', expected: [] },
    {
      name: 'versions compare as numbers',
      registry: [autoStep('x', '0.10.0')],
      from: '0.9.0',
      to: '0.10.0',
      expected: ['x'],
    },
  ];
  for (const { name, registry: steps, from, to, expected } of cases) {
    assert.deepEqual(ids(planSteps(steps, from, to)), expected, name);
  }
});

test('fromVersion starts from the marker, the baseline for a configured machine without one, or this version', () => {
  assert.equal(fromVersion('0.38.0', true, '0.40.0'), '0.38.0');
  assert.equal(fromVersion(undefined, true, '0.40.0'), MIGRATION_BASELINE);
  assert.equal(fromVersion(undefined, false, '0.40.0'), '0.40.0');
  assert.equal(fromVersion('0.41.0', true, '0.40.0'), '0.40.0');
  assert.equal(fromVersion(undefined, true, '0.30.0'), '0.30.0');
});
