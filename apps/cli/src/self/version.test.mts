import assert from 'node:assert/strict';
import { test } from 'node:test';
import { API_VERSION } from '@agent-board/shared';
import { versionLine } from './version.mts';

test('a release names the repository it updates from, a checkout says it updates with git pull', () => {
  assert.equal(versionLine('0.36.0', true), `board 0.36.0 (api ${API_VERSION}, updates from mloureiro/agent-board)`);
  assert.equal(versionLine('0.36.0-dev', false), `board 0.36.0-dev (api ${API_VERSION}, updates with git pull)`);
});
