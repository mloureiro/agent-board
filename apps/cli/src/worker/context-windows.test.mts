import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MAX_CONTEXT_TOKENS } from '@agent-board/shared';
import { contextWindowsFile, createContextWindowStore } from './context-windows.mts';

const file = () => contextWindowsFile(mkdtempSync(join(tmpdir(), 'agent-board-windows-')));

test('a missing or corrupt file reads as no windows', () => {
  const path = file();
  const store = createContextWindowStore(path);
  assert.deepEqual(store.read(), {});
  writeFileSync(path, '{ broken');
  assert.deepEqual(store.read(), {});
  writeFileSync(path, '["a"]');
  assert.deepEqual(store.read(), {});
});

test('entries with an unsafe model id or a window out of range are dropped on read', () => {
  const path = file();
  writeFileSync(
    path,
    JSON.stringify({
      'claude-haiku-5-5': 1_000_000,
      'claude-opus[1m]': 200_000,
      'bad model': 100,
      zero: 0,
      huge: MAX_CONTEXT_TOKENS + 1,
      fraction: 1.5,
      text: '100',
    }),
  );
  assert.deepEqual(createContextWindowStore(path).read(), {
    'claude-haiku-5-5': 1_000_000,
    'claude-opus[1m]': 200_000,
  });
});

test('a record merges over what is there, and the file is private', () => {
  const path = file();
  const store = createContextWindowStore(path);
  store.record({ a: 100, b: 200 });
  store.record({ b: 300, c: 400 });
  assert.deepEqual(store.read(), { a: 100, b: 300, c: 400 });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.ok(readFileSync(path, 'utf8').endsWith('\n'));
});

test('at most 64 models are kept, the ones just reported first', () => {
  const path = file();
  const store = createContextWindowStore(path);
  store.record(Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`old-${i}`, 100])));
  store.record({ fresh: 500 });
  const stored = store.read();
  assert.equal(Object.keys(stored).length, 64);
  assert.equal(stored['fresh'], 500);
});
