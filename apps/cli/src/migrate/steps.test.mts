import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { compareVersions } from '@agent-board/shared';
import { MIGRATION_BASELINE, MIGRATION_STEPS } from './steps.mts';
import type { MigrationStep } from './steps.mts';
import { STEP_ID_PATTERN, VERSION_PATTERN } from './layout.mts';

const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

function registryProblems(registry: readonly MigrationStep[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const step of registry) {
    if (!STEP_ID_PATTERN.test(step.id)) problems.push(`${step.id}: the id is not a lowercase slug`);
    if (seen.has(step.id)) problems.push(`${step.id}: the id is used twice`);
    seen.add(step.id);
    if (!VERSION_PATTERN.test(step.since)) problems.push(`${step.id}: since is not x.y.z`);
    else if (compareVersions(step.since, MIGRATION_BASELINE) <= 0)
      problems.push(`${step.id}: since is not after the baseline ${MIGRATION_BASELINE}`);
    else if (compareVersions(step.since, PACKAGE_VERSION) > 0)
      problems.push(`${step.id}: since is after this CLI, ${PACKAGE_VERSION}`);
  }
  return problems;
}

const step = (id: string, since: string): MigrationStep => ({
  kind: 'auto',
  id,
  since,
  title: id,
  run: async () => undefined,
});

test('the registry satisfies the invariants every step must keep', () => {
  assert.deepEqual(registryProblems(MIGRATION_STEPS), []);
});

test('the baseline is a release at or before this CLI', () => {
  assert.match(MIGRATION_BASELINE, VERSION_PATTERN);
  assert.ok(compareVersions(MIGRATION_BASELINE, PACKAGE_VERSION) <= 0);
});

test('the invariants reject a bad id, a repeated id, a malformed or out-of-range since', () => {
  assert.match(registryProblems([step('Bad_Id', '0.38.0')]).join('\n'), /Bad_Id: the id is not a lowercase slug/);
  assert.match(registryProblems([step('a', '0.38.0'), step('a', '0.38.0')]).join('\n'), /a: the id is used twice/);
  assert.match(registryProblems([step('a', '0.38')]).join('\n'), /a: since is not x\.y\.z/);
  assert.match(registryProblems([step('a', MIGRATION_BASELINE)]).join('\n'), /a: since is not after the baseline/);
  assert.match(registryProblems([step('a', '99.0.0')]).join('\n'), /a: since is after this CLI/);
});
