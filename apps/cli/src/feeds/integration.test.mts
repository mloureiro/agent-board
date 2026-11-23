import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CommandResult, CommandSpec } from '../dispatch/waits.mts';
import { check, describe, doctor, firstLine, list, parseDescription } from './integration.mts';

const reply = (partial: Partial<CommandResult>): CommandResult => ({
  exitCode: 0,
  timedOut: false,
  output: '',
  stdout: '',
  stderr: '',
  ...partial,
});

function recorder(partial: Partial<CommandResult> = {}) {
  const specs: CommandSpec[] = [];
  return { specs, run: (spec: CommandSpec) => (specs.push(spec), Promise.resolve(reply(partial))) };
}

const ACTION = { summary: 'PRs', options: { type: 'object' }, fields: ['url', 'title'] };
const described = (change: Record<string, unknown> = {}): string =>
  JSON.stringify({ protocol: 1, actions: { 'list-pull-requests': ACTION }, ...change });

test('each verb runs the quoted program with its words, in the feed directory, with the options on stdin where it takes them', async () => {
  const program = "/state dir/it's/run";
  const calls = recorder({ stdout: 'out' });
  await describe(program, '/work', calls.run);
  await check(program, 'list-pull-requests', { a: 1 }, '/work', calls.run);
  await list(program, 'list-pull-requests', { a: 1 }, '/work', calls.run, 90_000);
  assert.deepEqual(
    calls.specs.map(({ command, cwd, stdin, timeLimitMs }) => ({ command, cwd, stdin, timeLimitMs })),
    [
      { command: `'/state dir/it'\\''s/run' describe`, cwd: '/work', stdin: undefined, timeLimitMs: 30_000 },
      {
        command: `'/state dir/it'\\''s/run' check list-pull-requests`,
        cwd: '/work',
        stdin: '{"a":1}',
        timeLimitMs: 30_000,
      },
      { command: `'/state dir/it'\\''s/run' list-pull-requests`, cwd: '/work', stdin: '{"a":1}', timeLimitMs: 90_000 },
    ],
  );
});

test('a verb that fails says why: the exit, the first line of stderr, a time limit, a flood of output', async () => {
  const cases: [Partial<CommandResult>, RegExp][] = [
    [{ exitCode: 1, stderr: '\nbad option\nsecond line\n' }, /^check list-pull-requests exited 1: bad option$/],
    [{ exitCode: 127, stderr: 'env: python3: No such file or directory\n' }, /exited 127: env: python3: No such file/],
    [{ exitCode: null }, /exited by a signal$/],
    [{ exitCode: 2 }, /exited 2$/],
    [{ timedOut: true, exitCode: null }, /took longer than 30s/],
    [{ stdout: 'x'.repeat(200_000) }, /printed more than 200 KB/],
    [{ exitCode: 1, stderr: `\u001b[31m${'e'.repeat(500)}` }, /exited 1: \[31me{190,}$/],
  ];
  for (const [partial, reason] of cases) {
    const outcome = await check('/p', 'list-pull-requests', {}, '/work', recorder(partial).run);
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? '' : outcome.reason, reason);
  }
  assert.equal(firstLine(`${'e'.repeat(500)}`).length, 200);
});

test('an action that is not a plain name never reaches a shell line', async () => {
  const calls = recorder();
  for (const action of ['a b', '$(x)', '../x', '', 'A'])
    for (const outcome of [
      await check('/p', action, {}, '/work', calls.run),
      await list('/p', action, {}, '/work', calls.run, 1000),
    ])
      assert.equal(outcome.ok, false);
  assert.deepEqual(calls.specs, []);
});

test('parseDescription reads the actions with their options schema and fields', () => {
  const parsed = parseDescription(described(), 'acme:github');
  assert.deepEqual(typeof parsed === 'string' ? parsed : parsed.actions['list-pull-requests']?.fields, [
    'url',
    'title',
  ]);
  assert.equal(typeof parsed === 'string' ? '' : parsed.actions['list-pull-requests']?.summary, 'PRs');
  const bare = parseDescription(JSON.stringify({ protocol: 1, actions: { go: {} } }), 'acme:github');
  assert.deepEqual(typeof bare === 'string' ? bare : bare.actions['go']?.fields, []);
});

test('parseDescription refuses what it cannot rely on, with the integration named', () => {
  const cases: [string, string, RegExp][] = [
    ['not JSON', 'nope', /acme:github printed a describe answer that is not JSON/],
    ['not an object', '[]', /not a JSON object/],
    ['protocol 2', described({ protocol: 2 }), /acme:github speaks protocol 2; this CLI speaks 1/],
    ['no protocol', JSON.stringify({ actions: {} }), /speaks protocol undefined/],
    ['actions missing', JSON.stringify({ protocol: 1 }), /describes no actions object/],
    ['bad action name', described({ actions: { 'Bad Name': ACTION } }), /action named "Bad Name"/],
    ['action not an object', described({ actions: { go: 1 } }), /describes go with something that is not an object/],
    ['long summary', described({ actions: { go: { summary: 'x'.repeat(301) } } }), /summary/],
    [
      'schema keyword it does not read',
      described({ actions: { go: { options: { oneOf: [] } } } }),
      /acme:github describes go with options this CLI cannot use: schema uses a keyword this CLI does not read: "oneOf"/,
    ],
    [
      'seventeen fields',
      described({ actions: { go: { fields: Array.from({ length: 17 }, (_, n) => `f${n}`) } } }),
      /at most 16 names/,
    ],
    ['a field name with a dash', described({ actions: { go: { fields: ['a-b'] } } }), /fields that are not a list/],
    ['fields that are not text', described({ actions: { go: { fields: [1] } } }), /fields that are not a list/],
  ];
  for (const [label, stdout, reason] of cases) {
    const parsed = parseDescription(stdout, 'acme:github');
    assert.equal(typeof parsed, 'string', label);
    assert.match(String(parsed), reason, label);
  }
});

test('sixteen fields are accepted', () => {
  const fields = Array.from({ length: 16 }, (_, n) => `f${n}`);
  const parsed = parseDescription(described({ actions: { go: { fields } } }), 'acme:github');
  assert.deepEqual(typeof parsed === 'string' ? parsed : parsed.actions['go']?.fields, fields);
});

test('doctor runs with no stdin and the given PATH, and its summary is one clean line of at most 200 characters', async () => {
  const calls = recorder({ stdout: `\n  gh \u001b[31mis ready\u001b[0m ${'x'.repeat(300)}\nsecond line\n` });
  const answer = await doctor('/p/run', '/work', calls.run, '/units/bin');
  assert.equal(calls.specs[0]?.command, "'/p/run' doctor");
  assert.equal(calls.specs[0]?.stdin, undefined);
  assert.equal(calls.specs[0]?.path, '/units/bin');
  assert.equal(calls.specs[0]?.timeLimitMs, 30_000);
  assert.ok(answer.ok);
  const summary = answer.ok ? (answer.summary ?? '') : '';
  assert.equal(Array.from(summary).length, 200);
  assert.ok(!summary.includes('\u001b') && !summary.includes('second'));
  assert.deepEqual(await doctor('/p/run', '/work', recorder().run), { ok: true });
});

test('doctor fails with the first line of stderr as the reason, and with the time limit', async () => {
  const failed = await doctor('/p/run', '/work', recorder({ exitCode: 2, stderr: '\ngh is not logged in\nmore' }).run);
  assert.deepEqual(failed, { ok: false, reason: 'doctor exited 2: gh is not logged in' });
  const slow = await doctor('/p/run', '/work', recorder({ timedOut: true, exitCode: null }).run);
  assert.deepEqual(slow, { ok: false, reason: 'doctor took longer than 30s' });
});
