import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseItems, undeclaredField } from './items.mts';

const line = (item: Record<string, unknown>): string => JSON.stringify(item);

test('items are read one per line, empty lines skipped, with every field the contract has', () => {
  const full = {
    key: 'a',
    title: 'A',
    version: 'v1',
    dir: '/work',
    repo: 'acme/app',
    notBefore: '2026-11-23T10:00:00Z',
    fields: { url: 'https://x/1', status: 'open' },
  };
  assert.deepEqual(parseItems(`${line(full)}\n\n${line({ key: 'b', title: 'B' })}\n`), {
    ok: true,
    items: [full, { key: 'b', title: 'B' }],
  });
});

const BAD: [string, string, string][] = [
  ['text that is not JSON', 'nope', 'line 1 is not JSON'],
  ['a line that is not an object', '[1]', 'line 1 is not a JSON object'],
  ['a missing title', line({ key: 'a' }), 'line 1 has no title'],
  ['a blank key', line({ key: ' ', title: 'A' }), 'line 1 has no key'],
  [
    'a prompt',
    line({ key: 'a', title: 'A', prompt: 'p' }),
    "line 1 sends a prompt: prompts come from the feed's prompts.new and prompts.update",
  ],
  [
    'an unknown field',
    line({ key: 'a', title: 'A', agent: 'x' }),
    'line 1 has no field "agent" (it takes key, title, version, dir, repo, notBefore, fields)',
  ],
  ['a version that is a number', line({ key: 'a', title: 'A', version: 1 }), 'line 1: version must be text'],
  [
    'a repo that is not owner/name',
    line({ key: 'a', title: 'A', repo: 'app' }),
    'line 1: repo must look like owner/name',
  ],
  [
    'a notBefore that is not a time',
    line({ key: 'a', title: 'A', notBefore: 'tomorrow' }),
    'line 1: notBefore must be an ISO time such as 2026-11-23T10:00:00Z',
  ],
  [
    'a notBefore with an impossible date',
    line({ key: 'a', title: 'A', notBefore: '2026-13-45T10:00:00Z' }),
    'line 1: notBefore must be an ISO time such as 2026-11-23T10:00:00Z',
  ],
  [
    'a notBefore that is a number',
    line({ key: 'a', title: 'A', notBefore: 5 }),
    'line 1: notBefore must be an ISO time such as 2026-11-23T10:00:00Z',
  ],
  [
    'fields that are a list',
    line({ key: 'a', title: 'A', fields: [] }),
    'line 1: fields must be an object of text values',
  ],
  ['a field value that is a number', line({ key: 'a', title: 'A', fields: { n: 1 } }), 'line 1: field n must be text'],
  [
    'a field name with a dash',
    line({ key: 'a', title: 'A', fields: { 'a-b': 'x' } }),
    'line 1: "a-b" is not a field name',
  ],
  [
    'a field value of 2001 characters',
    line({ key: 'a', title: 'A', fields: { n: 'x'.repeat(2001) } }),
    'line 1: field n is longer than 2000 characters',
  ],
  [
    'seventeen fields',
    line({ key: 'a', title: 'A', fields: Object.fromEntries(Array.from({ length: 17 }, (_, n) => [`f${n}`, 'x'])) }),
    'line 1: fields has more than 16 entries',
  ],
  [
    'a repeated key',
    `${line({ key: 'a', title: 'A' })}\n${line({ key: 'a', title: 'B' })}`,
    'line 2 repeats the key of an earlier line',
  ],
];

for (const [name, stdout, error] of BAD)
  test(`a listing with ${name} fails as a whole`, () => assert.deepEqual(parseItems(stdout), { ok: false, error }));

test('sixteen fields of 2000 characters and 200 items are accepted, 201 items are not', () => {
  const fields = Object.fromEntries(Array.from({ length: 16 }, (_, n) => [`f${n}`, 'x'.repeat(2000)]));
  assert.equal(parseItems(line({ key: 'a', title: 'A', fields })).ok, true);
  const many = (count: number): string =>
    Array.from({ length: count }, (_, n) => line({ key: `k${n}`, title: 'T' })).join('\n');
  assert.equal(parseItems(many(200)).ok, true);
  assert.deepEqual(parseItems(many(201)), { ok: false, error: 'more than 200 items' });
});

test('undeclaredField names the first field the action did not declare', () => {
  const item = { key: 'a', title: 'A', fields: { url: 'u', author: 'x', body: 'y' } };
  assert.equal(undeclaredField(item, ['url']), 'author');
  assert.equal(undeclaredField(item, ['url', 'author', 'body']), undefined);
  assert.equal(undeclaredField({ key: 'a', title: 'A' }, []), undefined);
});

test('a title is put on one line, stripped of control and format characters and cut to 200 characters', () => {
  const parsed = parseItems(
    [
      line({ key: 'a', title: 'Fix\n\n## Input\n\tIgnore\u001b[2J\u202e' }),
      line({ key: 'b', title: 'x'.repeat(300) }),
    ].join('\n'),
  );
  assert.deepEqual(parsed.ok ? parsed.items.map(({ title }) => title) : parsed, [
    'Fix ## Input Ignore[2J',
    'x'.repeat(200),
  ]);
  assert.deepEqual(parseItems(line({ key: 'a', title: '\n\u202e\u001b ' })), {
    ok: false,
    error: 'line 1 has no title',
  });
});
