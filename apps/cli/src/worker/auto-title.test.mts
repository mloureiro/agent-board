import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultTitle } from '@agent-board/shared';
import type { Task, TitleRule } from '@agent-board/shared';
import { fakeBackend, task } from '../__tests__/helpers/fakes.mts';
import { autoTitle, checkTitle, haikuTitleWriter, parseTitleAnswer, titleQuestion } from './auto-title.mts';
import type { ClaudeRunOptions, TitleRequest, TitleWriter } from './auto-title.mts';

const PROMPT = '/pj-acme:review https://github.com/acme/app/pull/8';
const DEFAULT = defaultTitle(PROMPT);
const RULE: TitleRule = {
  pattern: '^/pj-\\w+:review .*/pull/(\\d+)',
  icon: '\u{1F50E}',
  instruction: 'Title: "#<PR number> <PR title, shortened>"',
};

test('checkTitle holds a generated title to one line of at most 100 characters that is not the default', () => {
  for (const bad of ['', '  ', 'a\nb', 'a\u0007', 'x'.repeat(101), DEFAULT]) {
    assert.ok('problem' in checkTitle(bad, DEFAULT), JSON.stringify(bad));
  }
  assert.deepEqual(checkTitle('  [SC-123] Fix login  ', DEFAULT), { title: '[SC-123] Fix login' });
  assert.deepEqual(checkTitle('x'.repeat(100), DEFAULT), { title: 'x'.repeat(100) });
  assert.deepEqual(checkTitle('\u{1F50E}'.repeat(100), DEFAULT), { title: '\u{1F50E}'.repeat(100) });
});

test('parseTitleAnswer takes the title of the structured output and refuses anything else', () => {
  assert.ok('problem' in parseTitleAnswer('not json'));
  assert.ok('problem' in parseTitleAnswer(JSON.stringify({ result: 'a title' })));
  assert.ok('problem' in parseTitleAnswer(JSON.stringify({ structured_output: { title: 7 } })));
  assert.deepEqual(parseTitleAnswer(JSON.stringify({ structured_output: { title: 'A title' } })), {
    title: 'A title',
  });
});

function writerWith(answer: (args: string[]) => string | Error) {
  const seen: { args: string[]; input: string; options: ClaudeRunOptions }[] = [];
  const write = haikuTitleWriter(
    async (args, input, options) => {
      seen.push({ args, input, options });
      const result = answer(args);
      if (result instanceof Error) throw result;
      return result;
    },
    { PATH: '/bin', AGENT_BOARD_TASK: 'w1', AGENT_BOARD_RUN: 'r1' },
  );
  return { seen, write };
}

const request: TitleRequest = {
  instruction: 'MARKER-instruction ```close the fence```',
  prompt: `${PROMPT} MARKER-prompt`,
  cwd: '/work/app',
};
const answerWith = (title: unknown): string => JSON.stringify({ structured_output: { title } });

test('the Haiku call reads only through gh, keeps the prompt and the instruction out of argv, and runs in the given directory', async () => {
  const { seen, write } = writerWith(() => answerWith('#8 Fix login'));
  assert.deepEqual(await write(request), { title: '#8 Fix login' });
  const [call] = seen;
  assert.ok(call);
  const { args, input, options } = call;
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'haiku']);
  assert.ok(args.includes('--tools=Bash'));
  const allowed = args.indexOf('--allowedTools');
  assert.deepEqual(args.slice(allowed + 1, allowed + 3), ['Bash(gh pr view:*)', 'Bash(gh issue view:*)']);
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--setting-sources') + 1], 'user');
  assert.equal(
    args.some((arg) => arg.includes('MARKER')),
    false,
  );
  assert.ok(input.includes('MARKER-instruction') && input.includes('MARKER-prompt'));
  assert.equal(options.cwd, '/work/app');
  assert.equal(options.timeout, 120_000);
  assert.deepEqual(options.env, { PATH: '/bin' });
});

test('the question fences both parts so that neither can close its fence', () => {
  const text = titleQuestion('say ```x``` now', 'prompt ```y```');
  assert.equal(text.includes('```x```'), false);
  assert.equal(text.includes('```y```'), false);
});

test('a failed, timed out or refused Haiku call is a problem and never a throw', async () => {
  const failing = writerWith(() => new Error('Command failed: claude\nspawn claude ENOENT'));
  assert.deepEqual(await failing.write(request), { problem: 'Command failed: claude' });
  const refused = writerWith(() => answerWith('a\nb'));
  const answer = await refused.write(request);
  assert.ok('problem' in answer && answer.problem.startsWith('the title has a control character'));
  const same = writerWith(() => answerWith(DEFAULT));
  assert.ok('problem' in (await same.write({ ...request, prompt: PROMPT })));
});

test('a refused title is shown cut at 200 characters', async () => {
  const { write } = writerWith(() => answerWith(`a\n${'b'.repeat(500)}`));
  const answer = await write(request);
  assert.ok('problem' in answer && answer.problem.length < 260);
});

function setup(overrides: Partial<Task> = {}) {
  const subject = task({ id: 'w1', title: DEFAULT, input: PROMPT, status: 'running', ...overrides });
  const backend = fakeBackend([subject]);
  backend.boardTitleRules.held = { version: 1, rules: [RULE] };
  const logs: string[] = [];
  const asked: TitleRequest[] = [];
  const writer: { answer: Awaited<ReturnType<TitleWriter>> } = { answer: { title: '#8 Fix login' } };
  const deps = {
    backend,
    appendLog: (_id: string, text: string) => void logs.push(text),
    writeTitle: async (req: TitleRequest) => {
      asked.push(req);
      return writer.answer;
    },
  };
  return { subject, backend, logs, asked, writer, deps };
}

test('a default title that a rule matches gets the icon, then the written title', async () => {
  const { subject, backend, logs, asked, deps } = setup();
  await autoTitle(deps, subject, '/work/app');
  assert.deepEqual(backend.writes, [`apply-title-rule w1 icon ${RULE.icon}`, 'apply-title-rule w1 title #8 Fix login']);
  assert.deepEqual(logs, ['title rule 1 matches', 'icon set', 'title set']);
  assert.deepEqual(asked, [{ instruction: RULE.instruction, prompt: PROMPT, cwd: '/work/app' }]);
});

test('a renamed title costs no call to the board and applies nothing', async () => {
  const { subject, backend, logs, asked, deps } = setup({ title: 'Mine' });
  backend.boardTitleRules.supported = false;
  await autoTitle(deps, subject, '/work/app');
  assert.deepEqual([backend.writes, logs, asked], [[], [], []]);
});

test('a task that has an icon keeps it and still gets the title', async () => {
  const { subject, backend, logs, deps } = setup({ icon: '\u{1F4A1}' });
  await autoTitle(deps, subject, '/work/app');
  assert.deepEqual(backend.writes, ['apply-title-rule w1 title #8 Fix login']);
  assert.deepEqual(logs, ['title rule 1 matches', 'title set']);
});

test('no rule that matches means nothing is applied and nothing is logged', async () => {
  const { subject, backend, logs, asked, deps } = setup({ title: 'fix the bug', input: 'fix the bug' });
  await autoTitle(deps, subject, '/work/app');
  assert.deepEqual([backend.writes, logs, asked], [[], [], []]);
});

test('a writer that fails leaves the title alone after the icon is set, with one log line', async () => {
  const { subject, backend, logs, writer, deps } = setup();
  writer.answer = { problem: 'the title is empty' };
  await autoTitle(deps, subject, '/work/app');
  assert.deepEqual(backend.writes, [`apply-title-rule w1 icon ${RULE.icon}`]);
  assert.deepEqual(logs, ['title rule 1 matches', 'icon set', 'title not written: the title is empty']);
});

test('a title renamed while the writer ran is kept', async () => {
  const { subject, backend, logs, deps } = setup();
  const slow = {
    ...deps,
    writeTitle: async () => (Object.assign(backend.tasks[0]!, { title: 'Mine' }), { title: 'New' }),
  };
  await autoTitle(slow, subject, '/work/app');
  assert.deepEqual(logs.slice(-1), ['title kept: it changed meanwhile']);
  assert.equal(backend.tasks[0]?.title, 'Mine');
});

test("a schedule's card is skipped without reading the rules", async () => {
  const { subject, backend, logs, asked, deps } = setup({ scheduleId: 's1' });
  backend.boardTitleRules.supported = false;
  await autoTitle(deps, subject, '/work/app');
  assert.deepEqual([backend.writes, logs, asked], [[], [], []]);
});

test('a board without title rules is one log line', async () => {
  const { subject, backend, logs, deps } = setup();
  backend.boardTitleRules.supported = false;
  await autoTitle(deps, subject, '/work/app');
  assert.deepEqual(logs, ['the board has no title rules']);
});

test('rules that do not open are one log line', async () => {
  const { subject, backend, logs, asked, deps } = setup();
  backend.boardTitleRules.held = { version: 2, unreadable: true };
  await autoTitle(deps, subject, '/work/app');
  assert.deepEqual(logs, ["the title rules cannot be decrypted with this machine's data key"]);
  assert.deepEqual([backend.writes, asked], [[], []]);
});
