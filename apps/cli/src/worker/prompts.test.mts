import assert from 'node:assert/strict';
import { test } from 'node:test';
import { note as makeNote, SESSION, task } from '../__tests__/helpers/fakes.mts';
import { START_MARKER, WAKE_MARKER, WATCH_MARKER } from '../task-rules.mts';
import type { WatchDef } from '../watch/store.mts';
import {
  boardRules,
  buildResumePrompt,
  freshThreadBlock,
  inboxMessageText,
  pauseMessageText,
  userReply,
} from './prompts.mts';
import { tail } from '../output/text.mts';

test("the board's rules tell the agent to attach the user's likely next reply to its final comment", () => {
  assert.match(
    boardRules(task({ id: 'abc' })),
    /board comment --suggest "<reply>" abc "<summary>".*Skip it when no single reply is obvious.*refuses `--suggest`.*without it/s,
  );
});

test("the board's rules tell the agent to report the PR it opens, except in an agent's run", () => {
  assert.match(boardRules(task({ id: 'abc' })), /open a pull request.*board pr abc <url>/s);
  assert.match(
    boardRules(task({ id: 'abc' })),
    /Report every pull request you open or work on for this task, each with its own `board pr abc <url>` call/,
  );
  assert.doesNotMatch(boardRules(task({ id: 'abc' })), /replaces the earlier/);
  assert.doesNotMatch(boardRules(task({ id: 'abc' }), { asAgent: true }), /board pr/);
});

test("the board's rules tell the agent to ask through the board, and an agent's run to keep its commands simple", () => {
  assert.match(
    boardRules(task({ id: 'abc' })),
    /AskUserQuestion is not available.*board ask abc --file \/tmp\/pr-abc-questions\.json/s,
  );
  assert.doesNotMatch(boardRules(task({ id: 'abc' })), /stands alone/);
  assert.match(boardRules(task({ id: 'abc' }), { asAgent: true }), /run every Bash command on its own, without pipes/);
});

test("the board's rules let the agent act alone on local, reversible steps and ask before visible or lasting ones", () => {
  const rules = boardRules(task({ id: 'abc' }));
  assert.match(rules, /Decide and act without asking on whatever is easy to undo and stays on this machine/);
  assert.match(
    rules,
    /Use `board ask` only before a step that is hard to undo or that other people see.*force-pushing.*merging/s,
  );
  assert.doesNotMatch(boardRules(task({ id: 'abc' }), { asAgent: true }), /Work on your own/);
});

test("the board's rules make an implementation task end in a pushed branch, a PR and CI", () => {
  const rules = boardRules(task({ id: 'abc' }));
  assert.match(rules, /implement, fix or change code.*request to commit, push and open a PR/s);
  assert.match(
    rules,
    /never the default branch.*git push -u origin HEAD.*gh pr create.*started or approved by hand.*Wait for CI.*PR link in your final `board comment`/s,
  );
  assert.match(rules, /only for a plan, an investigation or a review opens no PR/);
  assert.doesNotMatch(boardRules(task({ id: 'abc' }), { asAgent: true }), /gh pr create/);
});

test("the board's rules tell the agent not to end its turn while background work runs", () => {
  assert.match(boardRules(task({ id: 'abc' })), /Do not end your turn while a background agent .* in the foreground/s);
});

test('the finishing rule sends the task to needs-me, and offers done only when the task is set to auto-done', () => {
  for (const options of [{}, { asAgent: true }]) {
    const off = boardRules(task({ id: 'abc' }), options);
    assert.match(off, /then `board move abc needs-me`/);
    assert.doesNotMatch(off, /board move abc done/);
    const on = boardRules(task({ id: 'abc', autoDone: true }), options);
    assert.match(
      on,
      /every acceptance criterion of the task is met and nothing is left for the user to decide, answer, review or do, run `board move abc done`/,
    );
    assert.match(
      on,
      /whenever you are in doubt, run `board move abc needs-me` and attach to the summary the reply you expect/,
    );
    assert.match(on, /board comment --suggest "<reply>" abc "<summary>"/);
  }
});

test('long text is tailed', () => {
  assert.equal(tail('abcdef', 4), '…def');
});

test('the run rules tell the agent to start a watch instead of polling', () => {
  const rules = boardRules(task({ id: 'r' }));
  assert.match(rules, /board watch r --ci/);
  assert.match(rules, /board watch r --pr-review/);
  assert.match(rules, /board watch r --pr-merged` for the merge or close of that PR/);
  assert.match(rules, /board watch r --name <name> --every 1m -- '<command>'/);
  assert.match(rules, /board watch r --in 30m/);
  assert.match(rules, /board watches r.*board unwatch r <name>/);
  assert.doesNotMatch(rules, /board wait/);
});

test("an agent's run is told the watches that it may start: CI and a timer", () => {
  const rules = boardRules(task({ id: 'r' }), { asAgent: true });
  assert.match(rules, /board watch r --ci <pr-url>/);
  assert.match(rules, /board watch r --pr-review <pr-url>/);
  assert.match(rules, /board watch r --pr-merged <pr-url>/);
  assert.match(rules, /board watch r --in 30m/);
  assert.doesNotMatch(rules, /--every/);
});

const at = (minute: number): Date => new Date(Date.UTC(2026, 10, 13, 10, minute));

const start = (iso: number) => makeNote(`${START_MARKER} x`, at(iso), { author: 'system', kind: 'event' });

test('earlier findings alone point the fresh run at the thread; a first message on a never-run task is carried whole', () => {
  assert.equal(
    freshThreadBlock(task({ id: 'a', runStartedAt: at(20) }), [start(1), makeNote('Findings', at(5)), start(10)]),
    'The thread holds earlier notes: run `board show a` first to read it.',
  );
  const proposal = freshThreadBlock(task({ id: 'a' }), [makeNote('start with the API', at(1), { author: 'user' })]);
  assert.match(proposal ?? '', /start with the API/);
});

test('a reply leaves out the notes the agent was handed while it ran, and the resume prompt does not repeat them', () => {
  const user = (text: string, minute: number, extra: Partial<Parameters<typeof makeNote>[2]> = {}) =>
    makeNote(text, at(minute), { author: 'user', ...extra });
  const notes = [
    makeNote('Working on it', at(1), { author: 'agent' }),
    user('handed over mid-run', 2, { deliveredAt: at(3) }),
    user('said after the stop', 4),
  ];
  assert.deepEqual(
    userReply(notes).map((note) => note.text),
    ['said after the stop'],
  );
  const prompt = buildResumePrompt(task({ id: 'p', next: 'resume', sessionId: SESSION }), notes);
  assert.match(prompt ?? '', /said after the stop/);
  assert.doesNotMatch(prompt ?? '', /handed over mid-run/);
  assert.equal(
    buildResumePrompt(task({ id: 'p', next: 'resume', sessionId: SESSION }), notes.slice(0, 2)),
    undefined,
    'a thread whose only reply was handed over has nothing to resume with',
  );
});

test('a resume carries the messages the agent was never handed, even from before its last note, once', () => {
  const user = (text: string, minute: number, extra: Partial<Parameters<typeof makeNote>[2]> = {}) =>
    makeNote(text, at(minute), { author: 'user', ...extra });
  const start = (minute: number) =>
    makeNote(`${START_MARKER} on laptop`, at(minute), { author: 'system', kind: 'event' });
  const notes = [
    user('before the previous run', 0, { queued: true }),
    start(1),
    user('never handed over', 2, { queued: true }),
    user('handed over', 3, { queued: true, deliveredAt: at(4) }),
    makeNote('Done, here is the summary', at(5), { author: 'agent' }),
    user('and after it', 6),
    start(7),
  ];
  const reply = userReply(notes, at(7));
  assert.deepEqual(
    reply.map((note) => note.text),
    ['never handed over', 'and after it'],
  );
  const ordinary = userReply(
    [...notes.slice(0, 6)].map((n) => (n.text === 'and after it' ? { ...n, queued: true } : n)),
    at(7),
  );
  assert.equal(new Set(ordinary.map((n) => n.id)).size, ordinary.length, 'a note found twice is listed once');
});

test('the messages an agent is sent say who wrote them, and an interruption says it was one', () => {
  const message = makeNote('use the other table', at(1), { author: 'user' });
  assert.match(
    inboxMessageText('abc', message, false),
    /sent you a message on board task abc while you work:\n\nuse the other table/,
  );
  assert.match(
    inboxMessageText('abc', message, true),
    /interrupted you on board task abc to correct you:\n\nuse the other table/,
  );
  assert.match(pauseMessageText('abc'), /Pause requested.*`board comment abc "..."`.*end your turn/);
});

const EVENT = { name: 'ci', at: '2026-11-13T10:30:00.000Z', text: 'CI on https://github.com/acme/app/pull/7 passed.' };
const OPEN: Pick<WatchDef, 'name' | 'source' | 'everyMs' | 'deadline'>[] = [
  { name: 'health', source: { kind: 'timer' }, everyMs: 0, deadline: '2026-11-13T12:20:00.000Z' },
];
const resumable = (overrides: Partial<Parameters<typeof task>[0]> = {}) =>
  task({ id: 'p', next: 'resume', sessionId: SESSION, ...overrides });

test('a resume prompt carries the spooled events in place of the wake line, and events alone make one', () => {
  const wake = makeNote(`${WAKE_MARKER} watch "ci" reported.`, at(5), { author: 'system', kind: 'event' });
  const woken = buildResumePrompt(resumable({ woken: true }), [wake], { events: [EVENT], open: [] });
  assert.match(woken ?? '', /Watch "ci" on board task p reported\./);
  assert.match(woken ?? '', /<watch-event name="ci" at="2026-11-13T10:30:00.000Z">/);
  assert.match(woken ?? '', /No watch is open any more\./);
  assert.doesNotMatch(woken ?? '', /Your wait on board task p is over/);
  assert.match(buildResumePrompt(resumable(), [], { events: [EVENT], open: [] }) ?? '', /<watch-event/);
  assert.equal(buildResumePrompt(resumable(), [], { events: [], open: OPEN }), undefined);
});

test('events also go into a reply and a pause resume', () => {
  const reply = makeNote('use the other branch', at(5), { author: 'user' });
  const replied = buildResumePrompt(resumable(), [reply], { events: [EVENT], open: OPEN });
  assert.match(replied ?? '', /<watch-event[\s\S]*Still open: "health" \(at/);
  assert.match(replied ?? '', /The user replied on board task p:[\s\S]*use the other branch/);
  assert.match(
    buildResumePrompt(resumable({ paused: true }), [], { events: [EVENT], open: [] }) ?? '',
    /<watch-event[\s\S]*You were paused/,
  );
});

test('a feed update alone makes a resume prompt, and leads one that has a reply or watch events', () => {
  const update = 'Review https://gh/7 again.';
  const alone = buildResumePrompt(resumable(), [], undefined, update);
  assert.equal(
    alone,
    `The item board task p was made for has changed. The user's instructions for this update:\n\n${update}\n\nThe board's rules from the start of this session still hold.`,
  );
  const reply = makeNote('also check the tests', at(5), { author: 'user' });
  const replied = buildResumePrompt(resumable(), [reply], undefined, update) ?? '';
  assert.match(
    replied,
    /^The item board task p[\s\S]*Review https:\/\/gh\/7 again\.[\s\S]*The user replied on board task p:[\s\S]*also check the tests/,
  );
  const withEvents = buildResumePrompt(resumable(), [], { events: [EVENT], open: [] }, update) ?? '';
  assert.match(withEvents, /^The item board task p[\s\S]*Review https:\/\/gh\/7 again\.[\s\S]*<watch-event/);
  assert.equal(buildResumePrompt(resumable(), []), undefined);
});

test('a reply to questions the user dismissed says so, and an answered question keeps the plain line', () => {
  const asked = makeNote('Which one?', at(1), { author: 'agent', kind: 'question' });
  const comment = makeNote('start over with option B', at(3), { author: 'user', kind: 'comment' });
  const dismissed = buildResumePrompt(resumable(), [asked, comment]);
  assert.match(
    dismissed ?? '',
    /The user dismissed your questions on board task p without answering them, and replied:\n\nstart over with option B/,
  );
  assert.doesNotMatch(dismissed ?? '', /The user replied on board task p/);

  const answer = makeNote('thanks', at(3), { author: 'user', kind: 'answer' });
  const answered = buildResumePrompt(resumable(), [asked, answer]);
  assert.match(answered ?? '', /The user replied on board task p:/);
  assert.doesNotMatch(answered ?? '', /dismissed/);

  const spoke = makeNote('Done.', at(2), { author: 'agent', kind: 'comment' });
  assert.match(buildResumePrompt(resumable(), [asked, spoke, comment]) ?? '', /The user replied on board task p:/);
  assert.equal(buildResumePrompt(resumable(), [asked]), undefined, 'no reply, nothing to resume with');
});

test('a wake without events says what is still open', () => {
  const wake = makeNote(`${WAKE_MARKER} its time ran out.`, at(5), { author: 'system', kind: 'event' });
  const prompt = buildResumePrompt(resumable({ woken: true }), [wake], { events: [], open: OPEN });
  assert.match(prompt ?? '', /Your wait on board task p is over: its time ran out\.[\s\S]*Still open: "health"/);
});

test('an event note does not count as the agent having spoken', () => {
  const watchNote = makeNote(`${WATCH_MARKER} "ci" reported.\n\n\`\`\`\nfailed\n\`\`\``, at(6));
  const notes = [makeNote('Working on it', at(1)), makeNote('one more thing', at(4), { author: 'user' }), watchNote];
  assert.deepEqual(
    userReply(notes).map((reply) => reply.text),
    ['one more thing'],
  );
  const wake = makeNote(`${WAKE_MARKER} 20 minutes passed.`, at(7), { author: 'system', kind: 'event' });
  assert.match(buildResumePrompt(resumable({ woken: true }), [...notes, wake]) ?? '', /20 minutes passed/);
  assert.equal(freshThreadBlock(task({ id: 'a' }), [watchNote]), undefined, 'only the unit has written to the thread');
});
