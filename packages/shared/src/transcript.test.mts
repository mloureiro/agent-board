import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { RunEvent } from './transcript.mts';
import {
  logLine,
  MAX_BATCH_EVENTS,
  MAX_OUTPUT_CHARS,
  MAX_TEXT_CHARS,
  parseTranscriptEvent,
  parseWireTranscriptBatch,
  StreamCondenser,
  toolSummary,
  TranscriptError,
} from './transcript.mts';
import { parseContextEvent } from './context.mts';
import { deriveKeys, generateDataKey, seal } from './crypto.mts';

// A real `claude -p --output-format stream-json --verbose` run (Claude Code 2.1.325): thinking, two Bash calls (one
// failing), a subagent with its own Bash call, and the final result.
const lines = readFileSync(new URL('./__tests__/fixtures/stream.jsonl', import.meta.url), 'utf8').split('\n');
const at = new Date('2026-11-13T12:00:00Z');

test('a real stream condenses to notes, thinking, tool calls with results, text and the result', () => {
  const condenser = new StreamCondenser(() => at);
  const events = lines.flatMap((line) => condenser.line(line));
  assert.deepEqual(
    events.map((e) => e.seq),
    events.map((_, i) => i),
    'numbered in order',
  );
  assert.match(events[0]?.kind === 'note' ? events[0].text : '', /^Claude Code 2\.1\.325, claude-haiku-5-5, in \/tmp$/);
  const thinking = events.find((e) => e.kind === 'thinking');
  assert.ok(thinking?.kind === 'thinking' && thinking.tokens === 252, 'thinking keeps the token estimate');
  const failed = events.find((e) => e.kind === 'tool_result' && e.isError);
  assert.ok(failed?.kind === 'tool_result' && /nonexistent-file-xyz/.test(failed.output));
  const sub = events.filter((e) => e.parent !== null);
  assert.ok(
    sub.some((e) => e.kind === 'tool_use' && e.name === 'Bash' && toolSummary(e.name, e.input) === 'echo from-sub'),
    'subagent calls carry their parent',
  );
  assert.ok(events.some((e) => e.kind === 'result' && /done/.test(e.text)));
  assert.equal(events.find((e) => e.kind === 'tool_use')?.at, at.toISOString());
});

test('log lines show calls, failures and text, and skip the rest', () => {
  const condenser = new StreamCondenser(() => at);
  const log = lines
    .flatMap((line) => condenser.line(line))
    .map(logLine)
    .filter((line) => line !== undefined);
  assert.ok(log.includes('→ Bash: echo hello'));
  assert.ok(log.some((line) => line.startsWith('✗ Exit code 1')));
  assert.ok(log.includes('    → Bash: echo from-sub'), 'subagent lines are indented');
});

test('a huge tool result is cut with a note; a non-JSON line becomes a note', () => {
  const condenser = new StreamCondenser(() => at);
  const big = 'x'.repeat(MAX_OUTPUT_CHARS + 10);
  const [result] = condenser.line(
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: big }] } }),
  );
  assert.ok(
    result?.kind === 'tool_result' &&
      result.output.endsWith(`cut at ${MAX_OUTPUT_CHARS} of ${MAX_OUTPUT_CHARS + 10} characters`),
  );
  assert.deepEqual(
    condenser.line('Error: not json').map((e) => e.kind),
    ['note'],
  );
  assert.deepEqual(condenser.line('   '), []);
});

test('permission denials end up in the result', () => {
  const [result] = new StreamCondenser(() => at).line(
    JSON.stringify({
      type: 'result',
      result: 'x',
      is_error: false,
      num_turns: 3,
      permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'git push' } }],
    }),
  );
  assert.ok(result?.kind === 'result' && result.denials[0] === 'Bash {"command":"git push"}' && result.turns === 3);
});

test('tool summaries name what a person looks for', () => {
  assert.equal(toolSummary('Read', { file_path: '/a/b.ts' }), '/a/b.ts');
  assert.equal(toolSummary('Grep', { pattern: 'foo', path: 'src' }), 'foo in src');
  assert.equal(toolSummary('Skill', { skill: 'review-pr', args: '17741 --auto' }), 'review-pr 17741 --auto');
});

const keys = await deriveKeys(generateDataKey(), 'alice');
const DATA = await seal(keys, 'tr.data', 'run:0', '{"kind":"note","text":"x"}');
const OUTPUT = await seal(keys, 'tr.output', 'run:1', 'out');

const note = { seq: 0, at: at.toISOString(), parent: null, kind: 'note', data: DATA };
const result = {
  seq: 1,
  at: at.toISOString(),
  parent: null,
  kind: 'tool_result',
  data: DATA,
  output: OUTPUT,
  outputSize: 3,
};
const batch = {
  runId: '1b9a7c6e-aaaa',
  startedAt: at.toISOString(),
  sessionId: '7c1e2f0a-3b4d-4e5f-8a9b-0c1d2e3f4a5b',
  resumed: true,
  events: [note, result],
};

test('a batch is checked for shape', () => {
  const parsed = parseWireTranscriptBatch(batch);
  assert.deepEqual(parsed.events, [note, result]);
  assert.throws(() => parseWireTranscriptBatch({ ...batch, runId: '../x' }), TranscriptError);
  assert.throws(
    () => parseWireTranscriptBatch({ ...batch, events: [{ seq: 0, at: 'x', kind: 'weird' }] }),
    /known kind/,
  );
});

test('a context event is a wire kind with no output, and not a transcript event', () => {
  const context = { seq: 2, at: at.toISOString(), parent: null, kind: 'context', data: DATA };
  assert.deepEqual(parseWireTranscriptBatch({ ...batch, events: [context] }).events, [context]);
  assert.throws(
    () => parseWireTranscriptBatch({ ...batch, events: [{ ...context, output: OUTPUT, outputSize: 3 }] }),
    /only a tool result carries an output/,
  );
  const value = { seq: 2, at: at.toISOString(), parent: null, kind: 'context', used: 5, window: null, threshold: null };
  assert.equal(parseTranscriptEvent({ ...value, model: 'm' }), undefined);
});

test('a parent the board would refuse is dropped, not sent', () => {
  const condenser = new StreamCondenser(() => at);
  const text = (parent: string) =>
    JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: parent,
      message: { content: [{ type: 'text', text: 'hi' }] },
    });
  assert.equal(condenser.line(text('toolu_01abc'))[0]?.parent, 'toolu_01abc');
  assert.equal(condenser.line(text('not an id'))[0]?.parent, null);
  assert.equal(condenser.line(text('x'.repeat(300)))[0]?.parent, 'x'.repeat(256));
});

test('a batch holds its session id to a UUID and an event parent to a tool use id', () => {
  assert.equal(parseWireTranscriptBatch({ ...batch, sessionId: null }).sessionId, null);
  for (const sessionId of ['s', '--resume', 5]) {
    assert.throws(() => parseWireTranscriptBatch({ ...batch, sessionId }), /sessionId must be a UUID/);
  }
  const child = { ...note, parent: 'toolu_01ABCdef-2' };
  assert.deepEqual(parseWireTranscriptBatch({ ...batch, events: [child] }).events, [child]);
  for (const parent of ['', 'a b', 'x'.repeat(257), 'toolu\n', 5]) {
    assert.throws(() => parseWireTranscriptBatch({ ...batch, events: [{ ...note, parent }] }), /tool use id/);
  }
});

test('a batch needs an integer seq from 0, a date and at most the batch limit', () => {
  for (const bad of [{ seq: -1 }, { seq: 1.5 }, { seq: '1' }, { seq: 2 ** 31 }, { at: 'soon' }, { at: 5 }]) {
    assert.throws(() => parseWireTranscriptBatch({ ...batch, events: [{ ...note, ...bad }] }), TranscriptError);
  }
  assert.equal(
    parseWireTranscriptBatch({
      ...batch,
      events: Array.from({ length: MAX_BATCH_EVENTS }, (_, seq) => ({ ...note, seq })),
    }).events.length,
    MAX_BATCH_EVENTS,
  );
  assert.throws(
    () =>
      parseWireTranscriptBatch({
        ...batch,
        events: Array.from({ length: MAX_BATCH_EVENTS + 1 }, (_, seq) => ({ ...note, seq })),
      }),
    /at most 5000/,
  );
});

test('the server refuses plaintext data and plaintext output, and checks the output size it cannot measure', () => {
  const withEvents = (...events: unknown[]) => ({ ...batch, events });
  assert.throws(() => parseWireTranscriptBatch(withEvents({ ...note, data: '{"kind":"note"}' })), /must be encrypted/);
  assert.throws(() => parseWireTranscriptBatch(withEvents({ ...result, output: 'plain output' })), /must be encrypted/);
  assert.throws(() => parseWireTranscriptBatch(withEvents({ ...result, output: undefined })), /output/);
  for (const outputSize of [-1, 1.5, '3', null, MAX_OUTPUT_CHARS + 2048])
    assert.throws(() => parseWireTranscriptBatch(withEvents({ ...result, outputSize })), /outputSize/);
  assert.throws(() => parseWireTranscriptBatch(withEvents({ ...note, output: OUTPUT })), /only a tool result/);
  assert.throws(() => parseWireTranscriptBatch(withEvents({ ...note, outputSize: 3 })), /only a tool result/);
  assert.throws(() => parseWireTranscriptBatch(withEvents({ ...note, parent: 5 })), /parent/);
});

// The board refuses an event whose sealed data passes this, and a worker cannot get past a refused event: so no stream may
// produce one.
const DATA_LIMIT = 1024 * 1024;
const sealedBytes = (event: unknown): number => new TextEncoder().encode(JSON.stringify(event)).length;

test('every string of an event is bounded, so its sealed data stays under the board limit', () => {
  const huge = 'x'.repeat(1_500_000);
  // The worst case for the JSON size: control characters become six-character escapes, astral ones are two code units.
  const nasty = '\u0001'.repeat(MAX_TEXT_CHARS * 2);
  const stream: unknown[] = [
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: nasty },
          { type: 'thinking', thinking: nasty },
        ],
      },
    },
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: huge, name: huge, input: { command: nasty } }] },
    },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: huge, content: huge }] } },
    { type: 'system', subtype: 'task_notification', summary: huge, status: huge, tool_use_id: huge },
    `not json at all ${huge}`,
    {
      type: 'result',
      result: nasty,
      is_error: false,
      permission_denials: Array.from({ length: 500 }, () => ({ tool_name: 'Write', tool_input: { content: nasty } })),
    },
  ];
  const condenser = new StreamCondenser(() => at);
  const events = stream.flatMap((line) => condenser.line(typeof line === 'string' ? line : JSON.stringify(line)));
  assert.equal(events.length, 7);
  for (const event of events) {
    const { output, ...data } = event.kind === 'tool_result' ? event : { ...event, output: '' };
    assert.ok(sealedBytes(data) < DATA_LIMIT, `${event.kind} event is ${sealedBytes(data)} bytes`);
    assert.ok(output.length <= MAX_OUTPUT_CHARS + 100);
    if (event.parent !== null) assert.ok(event.parent.length <= 256);
  }
  const result = events.find((event) => event.kind === 'result');
  assert.ok(result?.kind === 'result' && result.denials.length === 21 && result.text.length < MAX_TEXT_CHARS + 100);
  assert.match(result.denials.at(-1) ?? '', /and 480 more denials/);
});

test('text within the bound is kept as it is', () => {
  const condenser = new StreamCondenser(() => at);
  const [event] = condenser.line(
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(MAX_TEXT_CHARS) }] } }),
  );
  assert.ok(event?.kind === 'text' && event.text.length === MAX_TEXT_CHARS);
});

test('every event the condenser makes reads back as itself, through JSON like the board stores it', () => {
  const condenser = new StreamCondenser(() => at);
  const events = lines.flatMap((line) => condenser.line(line));
  assert.ok(new Set(events.map((e) => e.kind)).size >= 5, 'the fixture covers most kinds');
  for (const event of events) {
    const stored: unknown = JSON.parse(JSON.stringify(event));
    assert.deepEqual(event.kind === 'context' ? parseContextEvent(stored) : parseTranscriptEvent(stored), event);
  }
});

test('an event read back fills what an older worker left out and refuses what does not fit its kind', () => {
  const base = { seq: 4, at: at.toISOString(), parent: null };
  assert.deepEqual(parseTranscriptEvent({ ...base, kind: 'result', text: 'done', isError: true }), {
    ...base,
    kind: 'result',
    text: 'done',
    isError: true,
    turns: null,
    durationMs: null,
    costUsd: null,
    denials: [],
  });
  assert.deepEqual(parseTranscriptEvent({ seq: 4, at: base.at, kind: 'thinking', text: '' }), {
    ...base,
    kind: 'thinking',
    text: '',
    tokens: null,
  });
  // The output of a tool result is sealed apart.
  assert.deepEqual(parseTranscriptEvent({ ...base, kind: 'tool_result', toolUseId: 't', isError: false }), {
    ...base,
    kind: 'tool_result',
    toolUseId: 't',
    isError: false,
    output: '',
  });
  for (const bad of [
    null,
    [],
    { ...base, kind: 'text' },
    { ...base, kind: 'later', text: 'x' },
    { ...base, seq: -1, kind: 'note', text: 'x' },
    { ...base, at: 5, kind: 'note', text: 'x' },
    { ...base, parent: 7, kind: 'note', text: 'x' },
    { ...base, kind: 'tool_use', toolUseId: 't' },
    { ...base, kind: 'result', text: 'x', isError: false, denials: [1] },
    { ...base, kind: 'result', text: 'x' },
  ])
    assert.equal(parseTranscriptEvent(bad), undefined, JSON.stringify(bad));
});

const contextLines = readFileSync(new URL('./__tests__/fixtures/context-stream.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter((line) => line !== '');

const mainLine = (usage: unknown, id = 'm1', parent: string | null = null, model = 'claude-haiku-5-5') =>
  JSON.stringify({
    type: 'assistant',
    parent_tool_use_id: parent,
    message: { id, model, content: [{ type: 'text', text: 'hi' }], usage },
  });
const contextOf = (events: RunEvent[]) => events.flatMap((e) => (e.kind === 'context' ? [e] : []));

test('a real stream gives one context reading per changed main agent message, the result window last, before the result', () => {
  const condenser = new StreamCondenser(() => at, { autoCompactPct: 80 });
  const events = contextLines.flatMap((line) => condenser.line(line));
  assert.deepEqual(
    contextOf(events).map((e) => [e.used, e.window, e.threshold, e.model, e.parent]),
    [
      [31520, null, 80, 'claude-haiku-5-5', null],
      [31989, null, 80, 'claude-haiku-5-5', null],
      [31989, 1_000_000, 80, 'claude-haiku-5-5', null],
    ],
  );
  const kinds = events.map((e) => e.kind);
  assert.equal(kinds.at(-1), 'result');
  assert.equal(kinds.at(-2), 'context');
});

test('the window comes from knownWindow until the result reports one, and the threshold is null unless the run sets it', () => {
  const condenser = new StreamCondenser(() => at, { knownWindow: (model) => (model === 'known' ? 200_000 : null) });
  const events = [
    ...condenser.line(mainLine({ input_tokens: 10, output_tokens: 5 }, 'a', null, 'known')),
    ...condenser.line(mainLine({ input_tokens: 10, output_tokens: 5 }, 'b', null, 'other')),
  ];
  assert.deepEqual(
    contextOf(events).map((e) => [e.window, e.threshold]),
    [
      [200_000, null],
      [null, null],
    ],
  );
});

test('a repeated message id emits only when its usage changed', () => {
  const condenser = new StreamCondenser(() => at);
  const usage = { input_tokens: 10, output_tokens: 5 };
  assert.equal(contextOf(condenser.line(mainLine(usage))).length, 1);
  assert.equal(contextOf(condenser.line(mainLine(usage))).length, 0);
  const grown = contextOf(condenser.line(mainLine({ input_tokens: 10, output_tokens: 9 })));
  assert.deepEqual(
    grown.map((e) => e.used),
    [19],
  );
});

test('a subagent line gives no context reading', () => {
  const condenser = new StreamCondenser(() => at);
  assert.deepEqual(contextOf(condenser.line(mainLine({ input_tokens: 10, output_tokens: 5 }, 's', 'toolu_1'))), []);
});

test('a malformed usage gives no reading and leaves the last one to compare against', () => {
  const condenser = new StreamCondenser(() => at);
  const usage = { input_tokens: 10, output_tokens: 5 };
  assert.equal(contextOf(condenser.line(mainLine(usage))).length, 1);
  assert.equal(contextOf(condenser.line(mainLine({ input_tokens: 'many', output_tokens: 5 }))).length, 0);
  assert.equal(contextOf(condenser.line(mainLine(usage, 'm2'))).length, 0);
});

test('a smaller reading after a compaction is emitted', () => {
  const condenser = new StreamCondenser(() => at);
  condenser.line(mainLine({ input_tokens: 90_000, output_tokens: 10 }));
  const after = contextOf(condenser.line(mainLine({ input_tokens: 4_000, output_tokens: 10 }, 'm2')));
  assert.deepEqual(
    after.map((e) => e.used),
    [4_010],
  );
});

test('a result whose window is the one already shown adds no reading', () => {
  const condenser = new StreamCondenser(() => at, { knownWindow: () => 1_000_000 });
  condenser.line(mainLine({ input_tokens: 10, output_tokens: 5 }));
  const result = JSON.stringify({
    type: 'result',
    result: 'done',
    modelUsage: { 'claude-haiku-5-5': { contextWindow: 1_000_000 } },
  });
  assert.deepEqual(
    condenser.line(result).map((e) => e.kind),
    ['result'],
  );
});
