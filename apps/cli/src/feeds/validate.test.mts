import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CommandResult, CommandSpec } from '../dispatch/waits.mts';
import { validateFeed } from './validate.mts';
import type { FeedBinding } from './validate.mts';

const SCHEMA = {
  type: 'object',
  properties: { repositories: { type: 'array', items: { type: 'string', pattern: '^[a-z]+/[a-z]+$' } } },
  additionalProperties: false,
};

const DESCRIBE = JSON.stringify({
  protocol: 1,
  actions: { 'list-pull-requests': { options: SCHEMA, fields: ['url', 'status'] } },
});

const FEED: FeedBinding = {
  integration: 'acme:github',
  action: 'list-pull-requests',
  options: { repositories: ['acme/app'] },
  prompts: { new: '/review {url} ({status}) {key} {title} {version}', update: '{url} changed' },
  dir: '/work',
};

interface Fake {
  describe?: Partial<CommandResult>;
  check?: Partial<CommandResult>;
}

function harness(fake: Fake = {}) {
  const verbs: string[] = [];
  const run = (spec: CommandSpec): Promise<CommandResult> => {
    const verb = spec.command.split(' ')[1] ?? '';
    verbs.push(verb);
    const partial = verb === 'describe' ? (fake.describe ?? { stdout: DESCRIBE }) : (fake.check ?? {});
    return Promise.resolve({ exitCode: 0, timedOut: false, output: '', stdout: '', stderr: '', ...partial });
  };
  return { verbs, run, resolve: () => ({ program: '/p', commit: 'c' }) };
}

test('a valid feed resolves to the program that was validated and names the fields it may use', async () => {
  const h = harness();
  assert.deepEqual(await validateFeed(FEED, h), { ok: true, program: '/p', fields: ['url', 'status'] });
  assert.deepEqual(h.verbs, ['describe', 'check']);
});

const FAILURES: [string, Partial<FeedBinding>, Fake, RegExp, string[]][] = [
  ['the integration does not resolve', {}, {}, /^marketplace acme is not installed/, []],
  [
    'describe fails',
    {},
    { describe: { exitCode: 1, stderr: 'boom' } },
    /^acme:github describe exited 1: boom/,
    ['describe'],
  ],
  ['describe is not JSON', {}, { describe: { stdout: 'x' } }, /not JSON/, ['describe']],
  [
    'the action is not described',
    { action: 'other' },
    {},
    /acme:github has no action other \(it has: list-pull-requests\)/,
    ['describe'],
  ],
  [
    'the options break the schema',
    { options: { repositories: ['acme/app', 'x'] } },
    {},
    /^options\.repositories\[1\] must match/,
    ['describe'],
  ],
  [
    'the options hold an option the schema does not know',
    { options: { query: 'q' } },
    {},
    /options\.query is not an option here/,
    ['describe'],
  ],
  [
    'prompts.new uses a field nobody provides',
    { prompts: { new: '{url} {author}', update: '{url}' } },
    {},
    /prompts\.new uses \{author\}.*provides key, title, version, url, status/,
    ['describe'],
  ],
  [
    'prompts.update uses a field nobody provides',
    { prompts: { new: '{url}', update: '{body}' } },
    {},
    /prompts\.update uses \{body\}/,
    ['describe'],
  ],
  [
    'check exits 1',
    {},
    { check: { exitCode: 1, stderr: 'query is empty\n' } },
    /^acme:github check list-pull-requests exited 1: query is empty/,
    ['describe', 'check'],
  ],
];

for (const [name, change, fake, reason, verbs] of FAILURES)
  test(`an invalid feed is refused when ${name}, after only the steps it needed`, async () => {
    const h = harness(fake);
    const resolve =
      name === 'the integration does not resolve'
        ? () => ({ problem: 'marketplace acme is not installed; board plugins install <its repository URL>' })
        : h.resolve;
    const result = await validateFeed({ ...FEED, ...change }, { run: h.run, resolve });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, reason);
    assert.deepEqual(h.verbs, verbs);
  });

test('a reason is one line of at most 300 characters', async () => {
  const h = harness();
  const result = await validateFeed(FEED, { ...h, resolve: () => ({ problem: 'x'.repeat(400) }) });
  assert.equal(result.ok ? 0 : result.reason.length, 300);
  const control = await validateFeed(FEED, { ...h, resolve: () => ({ problem: 'a\nb\u001bc' }) });
  assert.deepEqual(control, { ok: false, reason: 'a bc' });
});

test('the fields a prompt may use are listed once when the action also declares one the board provides', async () => {
  const describe = JSON.stringify({
    protocol: 1,
    actions: { 'list-pull-requests': { options: SCHEMA, fields: ['title', 'url'] } },
  });
  const result = await validateFeed(
    { ...FEED, prompts: { new: '{author}', update: '{url}' } },
    { run: harness({ describe: { stdout: describe } }).run, resolve: () => ({ program: '/p', commit: 'c' }) },
  );
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.reason : '', /provides key, title, version, url\)/);
});
