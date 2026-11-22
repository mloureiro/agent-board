import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_BATCH_EVENTS } from '@agent-board/shared';
import type { RunEvent } from '@agent-board/shared';
import { BackendError } from '../backend/backend.mts';
import { boundBacklog, createTranscriptUploader, splitBatches } from './transcript-upload.mts';
import type { TranscriptUploaderOptions } from './transcript-upload.mts';

const event = (seq: number): RunEvent => ({
  kind: 'text',
  seq,
  at: '2026-01-01T00:00:00Z',
  parent: null,
  text: 'x'.repeat(100),
});
const output = (seq: number, size: number): RunEvent => ({
  kind: 'tool_result',
  seq,
  at: '2026-01-01T00:00:00Z',
  parent: null,
  toolUseId: `t${seq}`,
  output: 'o'.repeat(size),
  isError: false,
});
const seqs = (events: RunEvent[]): number[] => events.map((e) => e.seq);
const refused = (): BackendError => new BackendError('transcript: refused', 400);
const down = (): BackendError => new BackendError('transcript: error from the board server (HTTP 503)', 503);

// An uploader whose calls and log lines the test can read; `post` decides what each call does.
function uploader(
  post: (events: RunEvent[], call: number) => Promise<void>,
  options: Partial<TranscriptUploaderOptions> = {},
) {
  const posted: number[][] = [];
  const logged: string[] = [];
  let clock = 0;
  const transcript = createTranscriptUploader({
    post: async (events) => {
      posted.push(seqs(events));
      await post(events, posted.length);
    },
    now: () => new Date(clock),
    log: (text) => logged.push(text),
    note: (text) => ({ kind: 'note', seq: 9_999, at: '2026-01-01T00:00:00Z', parent: null, text }),
    ...options,
  });
  return { transcript, posted, logged, advance: (ms: number) => (clock += ms) };
}

test('a backlog goes out in batches under the event and size limits', () => {
  const events = Array.from({ length: 7 }, (_, seq) => event(seq));
  const size = Buffer.byteLength(JSON.stringify(event(0)));
  assert.deepEqual(
    splitBatches(events, { maxEvents: 3 }).map((batch) => batch.length),
    [3, 3, 1],
  );
  assert.deepEqual(
    splitBatches(events, { maxBytes: size * 2 + 5 }).map((batch) => batch.length),
    [2, 2, 2, 1],
  );
  assert.deepEqual(
    splitBatches(events, { maxBytes: 10 }).map((batch) => batch.length),
    [1, 1, 1, 1, 1, 1, 1],
    'an event over the limit goes alone',
  );
  assert.deepEqual(splitBatches([]), []);
  assert.deepEqual(
    splitBatches(Array.from({ length: MAX_BATCH_EVENTS + 1 }, (_, seq) => event(seq))).map((batch) => batch.length),
    [MAX_BATCH_EVENTS, 1],
  );
});

test('a backlog over its size loses the oldest tool outputs first, then the oldest events', () => {
  const events = [output(0, 1_000), event(1), output(2, 1_000), event(3)];
  const outputsOnly = boundBacklog(events, { maxEvents: 10, maxBytes: 1_600 });
  assert.deepEqual([outputsOnly.droppedOutputs, outputsOnly.droppedEvents], [1, 0]);
  assert.deepEqual(
    outputsOnly.events.map((e) => (e.kind === 'tool_result' ? e.output.length : -1)),
    [0, -1, 1_000, -1],
  );
  const both = boundBacklog(events, { maxEvents: 3, maxBytes: 300 });
  assert.deepEqual(seqs(both.events), [2, 3]);
  assert.deepEqual([both.droppedOutputs, both.droppedEvents], [1, 2]);
});

test('a batch refused for good is halved until the event it cannot take is alone and dropped', async () => {
  const { transcript, posted, logged } = uploader(async (events) => {
    if (seqs(events).includes(2)) throw refused();
  });
  transcript.add([0, 1, 2, 3, 4].map(event));
  await transcript.start();
  assert.deepEqual(posted, [[0, 1, 2, 3, 4], [0, 1, 2], [0, 1], [2], [3, 4]]);
  assert.ok(logged.some((line) => line.startsWith('transcript event 2 was refused and dropped')));
  await transcript.flush();
  assert.equal(posted.length, 5, 'nothing is left to send');
});

test('a pass out of calls while halving keeps the whole batch, in order, ahead of what came in meanwhile', async () => {
  let refusing = true;
  const { transcript, posted } = uploader(
    async (events, call) => {
      if (call === 1) transcript.add([event(4)]);
      if (refusing && seqs(events).includes(1)) throw refused();
    },
    { maxCalls: 2 },
  );
  transcript.add([0, 1, 2, 3].map(event));
  await transcript.start();
  assert.deepEqual(posted, [
    [0, 1, 2, 3],
    [0, 1],
  ]);
  refusing = false;
  await transcript.start();
  assert.deepEqual(posted.at(-1), [0, 1, 2, 3, 4]);
});

test('a pass out of time leaves the failed batch and the ones after it ahead of what came in meanwhile', async () => {
  const { transcript, posted, advance } = uploader(async (_events, call) => {
    if (call === 1) {
      transcript.add([event(MAX_BATCH_EVENTS + 1)]);
      advance(61_000);
    }
  });
  transcript.add(Array.from({ length: MAX_BATCH_EVENTS + 1 }, (_, seq) => event(seq)));
  await transcript.start();
  assert.deepEqual(
    posted.map((batch) => batch.length),
    [MAX_BATCH_EVENTS],
  );
  await transcript.start();
  assert.deepEqual(posted.at(-1), [MAX_BATCH_EVENTS, MAX_BATCH_EVENTS + 1]);
});

test('an upload that fails for now keeps its events for the next pass, and the flush sends them', async () => {
  let up = false;
  const { transcript, posted, logged } = uploader(async () => {
    if (!up) throw down();
  });
  transcript.add([event(0), event(1)]);
  await transcript.start();
  assert.ok(logged.some((line) => line.startsWith('transcript upload failed')));
  up = true;
  transcript.add([event(2)]);
  await transcript.flush();
  assert.deepEqual(posted, [
    [0, 1],
    [0, 1, 2],
  ]);
});

test('a backlog over its budget is trimmed to 90% with a note in the transcript and the log', async () => {
  const { transcript, posted, logged } = uploader(async () => undefined, { maxEvents: 10 });
  transcript.add(Array.from({ length: 11 }, (_, seq) => event(seq)));
  assert.deepEqual(logged, ['transcript backlog over its budget: dropped 2 events']);
  await transcript.flush();
  assert.deepEqual(posted, [[2, 3, 4, 5, 6, 7, 8, 9, 10, 9_999]]);
});
