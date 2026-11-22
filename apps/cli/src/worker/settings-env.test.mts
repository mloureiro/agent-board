import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { autoCompactSetting, pickEnv, readMcpServers, readSettingsEnv } from './settings-env.mts';

test('settings.local.json wins over settings.json; a missing or broken file is skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-board-settings-'));
  mkdirSync(join(dir, '.claude'));
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ env: { A: 'shared', B: 'shared' } }));
  writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ env: { B: 'local', C: 3 } }));
  assert.deepEqual(readSettingsEnv(dir), { A: 'shared', B: 'local' });
  writeFileSync(join(dir, '.claude', 'settings.local.json'), '{ broken');
  assert.deepEqual(readSettingsEnv(dir), { A: 'shared', B: 'shared' });
  assert.deepEqual(readSettingsEnv(join(dir, 'nope')), {});
  assert.deepEqual(pickEnv({ A: '1', B: '2' }, ['A', 'Z']), { env: { A: '1' }, missing: ['Z'] });
});

test('the named servers come from .mcp.json; unknown names are reported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-board-mcp-'));
  writeFileSync(
    join(dir, '.mcp.json'),
    JSON.stringify({ mcpServers: { shortcut: { type: 'http', url: 'https://mcp.example' }, other: { command: 'x' } } }),
  );
  assert.deepEqual(readMcpServers(dir, ['shortcut', 'nope']), {
    config: { mcpServers: { shortcut: { type: 'http', url: 'https://mcp.example' } } },
    missing: ['nope'],
  });
  assert.deepEqual(readMcpServers(join(dir, 'none'), ['shortcut']).missing, ['shortcut']);
});

test('the auto-compact setting is the last layer that has it', () => {
  const name = 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE';
  assert.equal(autoCompactSetting([{ [name]: '60' }, {}, { [name]: '80' }, { OTHER: 'x' }]), '80');
  assert.equal(autoCompactSetting([{ [name]: '60' }, { [name]: undefined }]), '60');
  assert.equal(autoCompactSetting([{}, { OTHER: 'x' }]), undefined);
});
