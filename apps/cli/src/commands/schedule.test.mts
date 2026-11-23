import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dedupeKeyIndex, headIndex, polishTask } from '@agent-board/shared';
import type { TaskDraft } from '@agent-board/shared';
import { Command } from 'commander';
import {
  addScheduleOptions,
  parseDuplicateAnswer,
  parseScheduleArgs as toScheduleArgs,
  schedule,
  scheduleAfter,
  scheduleKeyed,
} from './schedule.mts';
import type { Duplicate, ScheduleArgs, ScheduleDeps, ScheduleFlags } from './schedule.mts';
import { BackendError } from '../backend/backend.mts';
import { fakeBackend, KEYS, task } from '../__tests__/helpers/fakes.mts';

// The command line as `board schedule` reads it: commander splits flags from the prompt, then the flags are checked.
function parseScheduleArgs(args: string[], now?: Date): ScheduleArgs {
  let parsed: ScheduleArgs | undefined;
  const program = new Command()
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({ outputError: () => undefined });
  addScheduleOptions(program.command('schedule').argument('<prompt...>').passThroughOptions()).action(
    (words: string[], flags: ScheduleFlags) => {
      parsed = toScheduleArgs(flags, words, now);
    },
  );
  program.parse(['schedule', ...args], { from: 'user' });
  if (!parsed) throw new Error('schedule did not run');
  return parsed;
}

test("the board's flags come first; the rest is the prompt, its own flags included", () => {
  assert.deepEqual(parseScheduleArgs(['--priority', 'high', '/review-pr', '17741', '--auto']), {
    prompt: '/review-pr 17741 --auto',
    priority: 'high',
    model: undefined,
    effort: undefined,
    icon: undefined,
    labels: undefined,
    lane: undefined,
    autoDone: false,
    agent: undefined,
    title: undefined,
    hold: false,
    backlog: false,
    notBefore: undefined,
    every: undefined,
    cron: undefined,
    moreCrons: [],
    after: undefined,
    delay: undefined,
    maxConcurrent: undefined,
    times: undefined,
    until: undefined,
    forceNew: false,
    polish: false,
    key: undefined,
    version: undefined,
  });
  assert.deepEqual(parseScheduleArgs(['--hold', '--new', '--title', 'Export', 'Find', 'out', 'why']), {
    prompt: 'Find out why',
    priority: undefined,
    model: undefined,
    effort: undefined,
    icon: undefined,
    labels: undefined,
    lane: undefined,
    autoDone: false,
    agent: undefined,
    title: 'Export',
    hold: true,
    backlog: false,
    notBefore: undefined,
    every: undefined,
    cron: undefined,
    moreCrons: [],
    after: undefined,
    delay: undefined,
    maxConcurrent: undefined,
    times: undefined,
    until: undefined,
    forceNew: true,
    polish: false,
    key: undefined,
    version: undefined,
  });
  assert.equal(parseScheduleArgs(['--', '--weird', 'prompt']).prompt, '--weird prompt');
  assert.throws(() => parseScheduleArgs(['--priority', 'asap', 'x']), /unknown priority/);
  assert.throws(() => parseScheduleArgs(['--hold']), /missing required argument 'prompt'/);
  assert.throws(() => parseScheduleArgs(['--hodl', 'x']), /unknown option '--hodl'/);
  assert.throws(() => parseScheduleArgs(['--hold', '  ']), /a prompt is required/);
  assert.equal(parseScheduleArgs(['--backlog', 'Find', 'out']).backlog, true);
  assert.throws(() => parseScheduleArgs(['--hold', '--backlog', 'x']), /cannot be combined/);
});

function setup(duplicate: Duplicate | undefined, choice?: 'requeue' | 'new' | 'abort') {
  const existing = task({ id: 'old', title: '#17741 Show postal code', input: '/review-pr 17741', status: 'needs-me' });
  const backend = fakeBackend([existing]);
  const printed: string[] = [];
  const asked: string[] = [];
  const deps: ScheduleDeps = {
    backend,
    machine: 'here',
    workdir: '/work/cosuno',
    timezone: 'Europe/Berlin',
    print: (line) => printed.push(line),
    link: (id) => `https://board.test/t/${id}`,
    check: async (_prompt, _workdir, open) => {
      asked.push(open.map((t) => t.id).join(','));
      return duplicate;
    },
    choose: choice === undefined ? undefined : async () => choice,
  };
  return { deps, backend, printed, asked };
}

test('without a duplicate the task is created, pinned to this machine and directory', async () => {
  const { deps, backend, printed } = setup(undefined);
  const created = (await schedule(deps, parseScheduleArgs(['--priority', 'high', '/grill', 'the', 'plan'])))?.task;
  assert.deepEqual(
    [created?.machine, created?.workdir, created?.priority, created?.createdBy, created?.status],
    ['here', '/work/cosuno', 'high', 'user', 'todo'],
  );
  assert.ok(backend.writes.some((w) => w.startsWith('create /grill the plan | /grill the plan')));
  assert.ok(printed.some((line) => line.startsWith('scheduled new')));
});

test('the duplicate check sees a task whose watches could not be read, and not one whose title could not be', async () => {
  const hidden = setup(undefined);
  hidden.backend.tasks[0]!.unreadable = ['title'];
  await schedule(hidden.deps, { ...parseScheduleArgs(['/grill', 'x']), forceNew: false });
  assert.deepEqual(hidden.asked, ['']);
  const watches = setup(undefined);
  watches.backend.tasks[0]!.unreadable = ['watches'];
  await schedule(watches.deps, { ...parseScheduleArgs(['/grill', 'x']), forceNew: false });
  assert.deepEqual(watches.asked, ['old']);
});

test('a likely duplicate can be requeued, created anyway, or dropped', async () => {
  const dup = { taskId: 'old', reason: 'same PR' };
  const requeue = setup(dup, 'requeue');
  const again = (await schedule(requeue.deps, parseScheduleArgs(['/review-pr', '17741'])))?.task;
  assert.equal(again?.id, 'old');
  assert.ok(requeue.backend.writes.includes('status old -> todo'));
  assert.ok(
    requeue.backend.writes.some((w) => w.startsWith('note old (system): Scheduled again from here:/work/cosuno')),
  );
  assert.ok(!requeue.backend.writes.some((w) => w.startsWith('create')));

  const fresh = setup(dup, 'new');
  await schedule(fresh.deps, parseScheduleArgs(['/review-pr', '17741']));
  assert.ok(fresh.backend.writes.some((w) => w.startsWith('create')));

  const abort = setup(dup, 'abort');
  assert.equal(await schedule(abort.deps, parseScheduleArgs(['/review-pr', '17741'])), undefined);
  assert.deepEqual(abort.backend.writes, []);
});

test('--backlog creates the task in Backlog, --hold in Needs me, neither in Todo', async () => {
  const statusOf = async (flags: string[]) =>
    (await schedule(setup(undefined).deps, parseScheduleArgs([...flags, 'do', 'it'])))?.task.status;
  assert.equal(await statusOf(['--backlog']), 'backlog');
  assert.equal(await statusOf(['--hold']), 'needs-me');
  assert.equal(await statusOf([]), 'todo');
});

test('a requeue lands in Backlog with --backlog and in Needs me with --hold', async () => {
  const dup = { taskId: 'old', reason: 'same PR' };
  const parked = setup(dup, 'requeue');
  await schedule(parked.deps, parseScheduleArgs(['--backlog', '/review-pr', '17741']));
  assert.ok(parked.backend.writes.includes('status old -> backlog'));
  const held = setup(dup, 'requeue');
  await schedule(held.deps, parseScheduleArgs(['--hold', '/review-pr', '17741']));
  assert.ok(held.backend.writes.includes('status old -> needs-me'));
});

test('without a terminal a duplicate is created with a warning; --new skips the check', async () => {
  const quiet = setup({ taskId: 'old', reason: 'same PR' });
  await schedule(quiet.deps, parseScheduleArgs(['/review-pr', '17741']));
  assert.ok(quiet.backend.writes.some((w) => w.startsWith('note new (system): Possibly a duplicate of old')));
  const forced = setup({ taskId: 'old', reason: 'same PR' });
  await schedule(forced.deps, parseScheduleArgs(['--new', '/review-pr', '17741']));
  assert.deepEqual(forced.asked, [], 'no check');
});

test('requeueing a task that is already queued or running changes nothing without a start time', async () => {
  const { deps, backend, printed } = setup({ taskId: 'old', reason: 'same' }, 'requeue');
  backend.tasks[0]!.status = 'running';
  await schedule(deps, parseScheduleArgs(['/review-pr', '17741']));
  assert.deepEqual(backend.writes, []);
  assert.ok(printed.some((line) => line.startsWith('old is already running')));
});

test("the model's answer counts only for a task that is really open", () => {
  const open = [task({ id: 'a1' })];
  const answer = (structured: unknown) => JSON.stringify({ structured_output: structured });
  assert.deepEqual(parseDuplicateAnswer(answer({ duplicate: true, taskId: 'a1', reason: 'same' }), open), {
    taskId: 'a1',
    reason: 'same',
  });
  assert.equal(parseDuplicateAnswer(answer({ duplicate: true, taskId: 'zz', reason: 'x' }), open), undefined);
  assert.equal(parseDuplicateAnswer(answer({ duplicate: false, taskId: null, reason: 'x' }), open), undefined);
});

const NOW = new Date(2026, 10, 14, 10, 0, 0);

test('--in and --at set when the task starts; both need Todo and exclude each other', () => {
  assert.equal(parseScheduleArgs(['--in', '2h', 'x'], NOW).notBefore?.getTime(), NOW.getTime() + 2 * 3_600_000);
  assert.equal(parseScheduleArgs(['--in', '1h30m', 'x'], NOW).notBefore?.getTime(), NOW.getTime() + 90 * 60_000);
  assert.equal(
    parseScheduleArgs(['--at', '14:30', 'x'], NOW).notBefore?.getTime(),
    new Date(2026, 10, 14, 14, 30).getTime(),
  );
  assert.equal(
    parseScheduleArgs(['--at', '2027-01-01', '--new', 'x'], NOW).notBefore?.getTime(),
    new Date(2027, 0, 1).getTime(),
  );
  assert.equal(parseScheduleArgs(['x'], NOW).notBefore, undefined);
  assert.throws(() => parseScheduleArgs(['--in', '1h', '--at', '14:30', 'x'], NOW), /--in and --at cannot be combined/);
  for (const flag of ['--hold', '--backlog'])
    for (const timing of [
      ['--in', '1h'],
      ['--at', '14:30'],
    ])
      assert.throws(
        () => parseScheduleArgs([flag, ...timing, 'x'], NOW),
        /cannot be combined with --hold or --backlog/,
      );
  assert.throws(() => parseScheduleArgs(['--in', 'soon', 'x'], NOW), /not a duration; use .*m, h, d, w/);
  assert.throws(() => parseScheduleArgs(['--in', '0m', 'x'], NOW), /longer than zero/);
  assert.throws(() => parseScheduleArgs(['--at', '2020-01-01', 'x'], NOW), /in the past/);
  assert.throws(() => parseScheduleArgs(['--at', 'tomorrow', 'x'], NOW), /not a time/);
  assert.throws(() => parseScheduleArgs(['--in'], NOW), /argument missing/);
  assert.throws(() => parseScheduleArgs(['--in', '1h'], NOW), /missing required argument 'prompt'/);
});

test('a delayed task is created in Todo with its start time, which the confirmation names', async () => {
  const { deps, backend, printed } = setup(undefined);
  const created = (await schedule(deps, parseScheduleArgs(['--in', '2h', '/grill', 'plan'])))?.task;
  assert.equal(created?.status, 'todo');
  assert.ok(created?.notBefore && created.notBefore.getTime() > Date.now() + 100 * 60_000);
  assert.ok(
    printed.some((line) => /^scheduled new .*, starts \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(line)),
    printed.join('\n'),
  );
  assert.equal(backend.writes.length, 1);
});

test('a requeue with a delay gives the requeued task the delay', async () => {
  const requeue = setup({ taskId: 'old', reason: 'same PR' }, 'requeue');
  const requeued = (await schedule(requeue.deps, parseScheduleArgs(['--in', '1h', '/review-pr', '17741'])))?.task;
  assert.ok(requeue.backend.writes.includes('status old -> todo'));
  assert.ok(requeue.backend.writes.some((w) => w.startsWith('notBefore old: ')));
  assert.ok(requeued?.notBefore);
  assert.ok(requeue.printed.some((line) => line.startsWith('requeued old') && line.includes(', starts ')));
});

test('--in or --at on a requeue of a task already in Todo delays that task', async () => {
  const requeue = setup({ taskId: 'old', reason: 'same PR' }, 'requeue');
  requeue.backend.tasks[0]!.status = 'todo';
  const delayed = (await schedule(requeue.deps, parseScheduleArgs(['--in', '1h', '/review-pr', '17741'])))?.task;
  assert.deepEqual(requeue.backend.writes, [`notBefore old: ${delayed?.notBefore?.toISOString()}`]);
  assert.ok(delayed?.notBefore && delayed.notBefore.getTime() > Date.now() + 50 * 60_000);
  assert.ok(requeue.printed.some((line) => line.startsWith('old is already queued, now starts ')));
});

test('a requeue of a running task with --in leaves it alone and says the start time was not applied', async () => {
  const { deps, backend, printed } = setup({ taskId: 'old', reason: 'same' }, 'requeue');
  backend.tasks[0]!.status = 'running';
  await schedule(deps, parseScheduleArgs(['--in', '1h', '/review-pr', '17741']));
  assert.deepEqual(backend.writes, []);
  assert.ok(printed.some((line) => line.startsWith('old is already running; the start time was not applied')));
});

test('--every and --cron repeat; --times or --until end the repeat; --in and --at set the first run', () => {
  const every = parseScheduleArgs(['--every', '2h', '--times', '5', 'x'], NOW);
  assert.deepEqual([every.every, every.times, every.cron, every.until], [2 * 3_600_000, 5, undefined, undefined]);
  const cron = parseScheduleArgs(['--cron', '0 9 * * 1-5', '--until', '2027-06-01', 'x'], NOW);
  assert.deepEqual(
    [cron.cron, cron.every, cron.until?.getTime()],
    ['0 9 * * 1-5', undefined, new Date(2027, 5, 1).getTime()],
  );
  const first = parseScheduleArgs(['--in', '2h', '--every', '2h', 'x'], NOW);
  assert.equal(first.notBefore?.getTime(), NOW.getTime() + 2 * 3_600_000);
  assert.equal(parseScheduleArgs(['--every', '1h', 'x'], NOW).notBefore, undefined);
});

test('repeat flags that cannot go together, or are malformed, are usage errors', () => {
  const bad = (flags: string[], message: RegExp) =>
    assert.throws(() => parseScheduleArgs([...flags, 'x'], NOW), message, flags.join(' '));
  bad(['--every', '1h', '--cron', '0 9 * * *'], /--every and --cron cannot be combined/);
  bad(['--times', '3'], /end a repeat; add --every, --cron or --after/);
  bad(['--until', '2027-01-01'], /end a repeat/);
  bad(['--every', '1h', '--times', '2', '--until', '2027-01-01'], /--times and --until cannot be combined/);
  bad(['--every', '1h', '--hold'], /cannot be combined with --hold or --backlog/);
  bad(['--cron', '0 9 * * *', '--backlog'], /cannot be combined with --hold or --backlog/);
  bad(['--every', '1h', '--times', '0'], /positive whole number/);
  bad(['--every', '1h', '--times', '2.5'], /positive whole number/);
  bad(['--every', '1h', '--times', 'two'], /positive whole number/);
  bad(['--every', 'often'], /not a duration/);
  bad(['--cron', '0 9 * *'], /5 fields/);
  bad(['--cron', '0 0 9 * * *'], /5 fields/);
  bad(['--every', '1h', '--until', '2020-01-01'], /in the past/);
  bad(['--every', '1h', '--in', '3h', '--until', '11:00'], /--until is before the first run/);
  assert.throws(() => parseScheduleArgs(['--every'], NOW), /argument missing/);
  bad(['--every', '1h', '--in', '1h', '--at', '14:30'], /--in and --at cannot be combined/);
});

test('a repeat creates a schedule bound to this machine, skips the duplicate check and names the first run', async () => {
  const { deps, backend, printed, asked } = setup({ taskId: 'old', reason: 'same PR' }, 'requeue');
  const created = (
    await schedule(
      deps,
      parseScheduleArgs(
        ['--priority', 'high', '--in', '1h', '--every', '2h', '--times', '3', '/review-pr', '17741'],
        NOW,
      ),
    )
  )?.task;
  assert.deepEqual(asked, [], 'no duplicate check');
  assert.equal(created?.scheduleId, 'sched');
  assert.equal(backend.writes.length, 1);
  assert.ok(backend.writes[0]?.startsWith('add-schedule /review-pr 17741 | /review-pr 17741 | 7200000 | start '));
  assert.ok(backend.writes[0]?.endsWith('| times 3 | here:/work/cosuno'));
  assert.equal(printed.length, 1);
  assert.match(
    printed[0] ?? '',
    /^scheduled repeat sched: every 2h, 3 runs; first run \d{4}-\d{2}-\d{2} \d{2}:\d{2} https:\/\/board\.test\/t\/pending$/,
  );
});

test('--cron can be given several times: the first is cron, the others more', async () => {
  const args = parseScheduleArgs(['--cron', '0 9 * * 5#1', '--cron', ' 0  9 * * 5#3 ', 'x'], NOW);
  assert.deepEqual([args.cron, args.moreCrons], ['0 9 * * 5#1', ['0  9 * * 5#3']]);
  assert.deepEqual(toScheduleArgs({ cron: '0 9 * * *' }, ['x'], NOW).moreCrons, []);
  const { deps, backend, printed } = setup(undefined);
  await schedule(deps, args);
  assert.ok(backend.writes[0]?.includes('| 0 9 * * 5#1 Europe/Berlin'));
  assert.ok(backend.writes[0]?.includes('| more 0  9 * * 5#3'));
  assert.match(printed[0] ?? '', /^scheduled repeat sched: cron 0 9 \* \* 5#1 \| 0 {2}9 \* \* 5#3 \(Europe\/Berlin\);/);
});

test('several --cron are checked: five fields each, at most ten, none twice', () => {
  const bad = (flags: string[], message: RegExp) =>
    assert.throws(() => parseScheduleArgs([...flags, 'x'], NOW), message, flags.join(' '));
  bad(['--cron', '0 9 * * *', '--cron', '0 9 * *'], /5 fields/);
  bad(['--cron', '0 9 * * *', '--cron', '0 9  * * *'], /given twice/);
  const eleven = Array.from({ length: 11 }, (_, hour) => ['--cron', `0 ${hour} * * *`]).flat();
  bad(eleven, /at most 10 times/);
  assert.equal(parseScheduleArgs([...eleven.slice(0, 20), 'x'], NOW).moreCrons.length, 9);
  bad(['--every', '1h', '--cron', '0 9 * * *'], /--every and --cron cannot be combined/);
});

test('--max-concurrent limits a repeat and nothing else', async () => {
  assert.equal(parseScheduleArgs(['--every', '1h', '--max-concurrent', '2', 'x'], NOW).maxConcurrent, 2);
  assert.equal(parseScheduleArgs(['--cron', '0 9 * * *', '--max-concurrent', '100', 'x'], NOW).maxConcurrent, 100);
  assert.equal(parseScheduleArgs(['--after', 's1b', '--max-concurrent', '1', 'x'], NOW).maxConcurrent, 1);
  const bad = (flags: string[], message: RegExp) =>
    assert.throws(() => parseScheduleArgs([...flags, 'x'], NOW), message, flags.join(' '));
  bad(['--max-concurrent', '2'], /limits a repeat; add --every, --cron or --after/);
  bad(['--every', '1h', '--max-concurrent', '0'], /from 1 to 100/);
  bad(['--every', '1h', '--max-concurrent', '101'], /from 1 to 100/);
  bad(['--every', '1h', '--max-concurrent', '1.5'], /from 1 to 100/);
  bad(['--every', '1h', '--max-concurrent', 'many'], /from 1 to 100/);
  const { deps, backend, printed } = setup(undefined);
  await schedule(deps, parseScheduleArgs(['--every', '1h', '--max-concurrent', '2', '/sweep'], NOW));
  assert.ok(backend.writes[0]?.endsWith('| max 2'));
  assert.equal(printed.length, 1);
});

test('--after makes a schedule with no task, with an optional delay', async () => {
  const args = parseScheduleArgs(['--after', 's1b2c3d4', '--delay', '10m', '--times', '3', '/deploy'], NOW);
  assert.deepEqual(
    [args.after, args.delay, args.times, args.every, args.cron],
    ['s1b2c3d4', 600_000, 3, undefined, undefined],
  );
  assert.equal(parseScheduleArgs(['--after', 's1b2c3d4', 'x'], NOW).delay, undefined);
  const { deps, backend, printed, asked } = setup({ taskId: 'old', reason: 'same PR' }, 'requeue');
  const made = await scheduleAfter(deps, args);
  assert.deepEqual(asked, [], 'no duplicate check');
  assert.equal(made.after?.scheduleId, 's1b2c3d4');
  assert.ok(backend.writes[0]?.startsWith('add-schedule /deploy | /deploy | after'));
  assert.ok(backend.writes[0]?.includes('| after s1b2c3d4 +600000'));
  assert.ok(backend.writes[0]?.includes('| times 3'));
  assert.equal(printed.length, 1);
  assert.match(
    printed[0] ?? '',
    /^scheduled repeat sched: after s1b2c3d4 \+10m, 3 runs; its first task is made when a task of that schedule finishes$/,
  );
});

test('--after excludes the other ways to say when, --delay goes with --after', () => {
  const bad = (flags: string[], message: RegExp) =>
    assert.throws(() => parseScheduleArgs([...flags, 'x'], NOW), message, flags.join(' '));
  for (const flags of [
    ['--every', '1h'],
    ['--cron', '0 9 * * *'],
    ['--in', '1h'],
    ['--at', '09:00'],
    ['--hold'],
    ['--backlog'],
    ['--key', 'k'],
    ['--polish'],
  ])
    bad(
      ['--after', 's1b', ...flags],
      new RegExp(`--after makes a schedule that waits for another one; it cannot be combined with ${flags[0]}`),
    );
  bad(['--delay', '10m'], /--delay belongs to --after/);
  bad(['--every', '1h', '--delay', '10m'], /--delay belongs to --after/);
  bad(['--after', 's1b', '--delay', 'soon'], /not a duration/);
  bad(['--after', 's1'], /id of a schedule/);
  bad(['--after', '../x'], /id of a schedule/);
});

test('a cron repeat sends the machine time zone and says nothing about duplicates', async () => {
  const { deps, backend, printed } = setup({ taskId: 'old', reason: 'same PR' }, 'requeue');
  await schedule(deps, parseScheduleArgs(['--cron', '0 9 * * 1-5', 'daily', 'sweep'], NOW));
  assert.ok(backend.writes[0]?.includes('| 0 9 * * 1-5 Europe/Berlin'));
  assert.match(printed[0] ?? '', /^scheduled repeat sched: cron 0 9 \* \* 1-5 \(Europe\/Berlin\);/);
  assert.ok(!printed.some((line) => line.includes('Looks like')));
});

test('--model is checked and sent for a plain task and for a repeat', async () => {
  assert.equal(parseScheduleArgs(['--model', 'opus', 'x']).model, 'opus');
  assert.equal(parseScheduleArgs(['--model', 'claude-sonnet-5-5[1m]', 'x']).model, 'claude-sonnet-5-5[1m]');
  assert.equal(parseScheduleArgs(['x']).model, undefined);
  for (const bad of ['--x', 'a b', 'opus;ls', ''])
    assert.throws(() => parseScheduleArgs(['--model', bad, 'x']), /is not a model name|argument missing/, bad);

  const plain = setup(undefined);
  const created = (await schedule(plain.deps, parseScheduleArgs(['--model', 'haiku', '--new', '/sweep'])))?.task;
  assert.equal(created?.model, 'haiku');
  const none = setup(undefined);
  assert.equal((await schedule(none.deps, parseScheduleArgs(['--new', '/sweep'])))?.task.model, null);

  const repeat = setup(undefined);
  const first = (await schedule(repeat.deps, parseScheduleArgs(['--model', 'fable', '--every', '2h', '/sweep'], NOW)))
    ?.task;
  assert.equal(first?.model, 'fable');
  assert.ok(repeat.backend.writes[0]?.endsWith('| here:/work/cosuno | model fable'));
});

test('--icon is checked and sent for a plain task and for a repeat, and a requeue says it was not applied', async () => {
  assert.equal(parseScheduleArgs(['--icon', '🧪', 'x']).icon, '🧪');
  assert.equal(parseScheduleArgs(['x']).icon, undefined);
  for (const bad of ['test', '🧪🧪', ':test_tube:'])
    assert.throws(() => parseScheduleArgs(['--icon', bad, 'x']), /not an icon: give one emoji/, bad);

  const plain = setup(undefined);
  assert.equal((await schedule(plain.deps, parseScheduleArgs(['--icon', '🧪', '--new', '/sweep'])))?.task.icon, '🧪');
  const repeat = setup(undefined);
  const first = (await schedule(repeat.deps, parseScheduleArgs(['--icon', '🧹', '--every', '2h', '/sweep'], NOW)))
    ?.task;
  assert.equal(first?.icon, '🧹');
  assert.ok(repeat.backend.writes[0]?.includes('| icon 🧹'));

  const requeue = setup({ taskId: 'old', reason: 'same PR' }, 'requeue');
  await schedule(requeue.deps, parseScheduleArgs(['--icon', '🧪', '/review-pr', '17741']));
  assert.ok(
    requeue.printed.includes(
      'old keeps its icon (none); --icon applies only to a new task: use `board task old set icon 🧪`',
    ),
  );
});

test('--label is repeatable, checked and sent for a plain task and for a repeat, and a requeue says it was not applied', async () => {
  assert.deepEqual(parseScheduleArgs(['--label', 'bug', '--label', 'ui', 'x']).labels, ['bug', 'ui']);
  assert.equal(parseScheduleArgs(['x']).labels, undefined);
  assert.throws(() => parseScheduleArgs(['--label', '-x', 'x']), /not a label/);

  const plain = setup(undefined);
  const made = await schedule(plain.deps, parseScheduleArgs(['--label', 'bug', '--new', '/sweep']));
  assert.deepEqual(made?.task.labels, ['bug']);
  const repeat = setup(undefined);
  const first = (await schedule(repeat.deps, parseScheduleArgs(['--label', 'chore', '--every', '2h', '/sweep'], NOW)))
    ?.task;
  assert.deepEqual(first?.labels, ['chore']);
  assert.ok(repeat.backend.writes[0]?.includes('| labels chore'));

  const requeue = setup({ taskId: 'old', reason: 'same PR' }, 'requeue');
  await schedule(requeue.deps, parseScheduleArgs(['--label', 'bug', '/review-pr', '17741']));
  assert.ok(
    requeue.printed.includes(
      'old keeps its labels (none); --label applies only to a new task: use `board task old set labels`',
    ),
  );
});

test('--effort is checked and sent for a plain task and for a repeat', async () => {
  assert.equal(parseScheduleArgs(['--effort', 'xhigh', 'x']).effort, 'xhigh');
  assert.equal(parseScheduleArgs(['x']).effort, undefined);
  for (const bad of ['huge', 'High', '--x', ''])
    assert.throws(
      () => parseScheduleArgs(['--effort', bad, 'x']),
      /unknown effort .*low, medium, high, xhigh, max|argument missing/,
      bad,
    );

  const plain = setup(undefined);
  const created = (await schedule(plain.deps, parseScheduleArgs(['--effort', 'low', '--new', '/sweep'])))?.task;
  assert.equal(created?.effort, 'low');
  const none = setup(undefined);
  assert.equal((await schedule(none.deps, parseScheduleArgs(['--new', '/sweep'])))?.task.effort, null);

  const repeat = setup(undefined);
  const first = (await schedule(repeat.deps, parseScheduleArgs(['--effort', 'max', '--every', '2h', '/sweep'], NOW)))
    ?.task;
  assert.equal(first?.effort, 'max');
  assert.ok(repeat.backend.writes[0]?.endsWith('| here:/work/cosuno | effort max'));
});

test('--lane is checked and sent for a plain task, a keyed one and a repeat, and only when given', async () => {
  assert.equal(parseScheduleArgs(['--lane', 'reviews', 'x']).lane, 'reviews');
  assert.equal(parseScheduleArgs(['x']).lane, undefined);
  for (const bad of ['a b', 'lane;ls', '-x', '.x', 'l'.repeat(65)])
    assert.throws(() => parseScheduleArgs(['--lane', bad, 'x']), /is not a lane name/, bad);

  const plain = setup(undefined);
  assert.equal(
    (await schedule(plain.deps, parseScheduleArgs(['--lane', 'reviews', '--new', '/sweep'])))?.task.requestedLane,
    'reviews',
  );
  const none = setup(undefined);
  assert.equal((await schedule(none.deps, parseScheduleArgs(['--new', '/sweep'])))?.task.requestedLane, null);

  const keyed = setup(undefined);
  const made = await schedule(keyed.deps, parseScheduleArgs(['--lane', 'reviews', '--key', 'k1', '/sweep']));
  assert.equal(made?.task.requestedLane, 'reviews');

  const repeat = setup(undefined);
  const first = (await schedule(repeat.deps, parseScheduleArgs(['--lane', 'reviews', '--every', '2h', '/sweep'], NOW)))
    ?.task;
  assert.equal(first?.requestedLane, 'reviews');
  assert.ok(repeat.backend.writes[0]?.includes(' | lane reviews'));
});

test('--key on a task that exists leaves its lane alone: no other-agent, no change, a requeue keeps it', async () => {
  const same = keyedSetup({ head: 'sha2', requestedLane: 'docs' });
  const outcome = await schedule(same.deps, parseScheduleArgs(['--lane', 'reviews', ...KEYED]));
  assert.deepEqual(outcome?.keyed, { result: 'exists', reason: 'same-version' });
  assert.equal(same.backend.tasks[0]?.requestedLane, 'docs');
  const requeued = keyedSetup({ status: 'done', requestedLane: 'docs' });
  assert.deepEqual((await schedule(requeued.deps, parseScheduleArgs(['--lane', 'reviews', ...KEYED])))?.keyed, {
    result: 'requeued',
  });
  assert.equal(requeued.backend.tasks[0]?.requestedLane, 'docs');
});

test('a requeue keeps the existing task lane and says --lane was not applied', async () => {
  const requeue = setup({ taskId: 'old', reason: 'same PR' }, 'requeue');
  await schedule(requeue.deps, parseScheduleArgs(['--lane', 'reviews', '/review-pr', '17741']));
  assert.ok(
    requeue.printed.includes(
      'old keeps its lane (the default); --lane applies only to a new task: use `board task old set lane reviews`',
    ),
  );
});

test('--auto-done is sent for a plain task, a keyed one and a repeat, and only when given', async () => {
  assert.equal(parseScheduleArgs(['--auto-done', 'x']).autoDone, true);
  assert.equal(parseScheduleArgs(['x']).autoDone, false);

  const plain = setup(undefined);
  assert.equal(
    (await schedule(plain.deps, parseScheduleArgs(['--auto-done', '--new', '/sweep'])))?.task.autoDone,
    true,
  );
  const none = setup(undefined);
  assert.equal((await schedule(none.deps, parseScheduleArgs(['--new', '/sweep'])))?.task.autoDone, false);

  const keyed = setup(undefined);
  const made = await schedule(keyed.deps, parseScheduleArgs(['--auto-done', '--key', 'k1', '/sweep']));
  assert.equal(made?.task.autoDone, true);

  const repeat = setup(undefined);
  await schedule(repeat.deps, parseScheduleArgs(['--auto-done', '--every', '2h', '/sweep'], NOW));
  assert.ok(repeat.backend.writes[0]?.endsWith('| auto-done'));
  const off = setup(undefined);
  await schedule(off.deps, parseScheduleArgs(['--every', '2h', '/sweep'], NOW));
  assert.ok(!off.backend.writes[0]?.includes('auto-done'));
});

test('a requeue keeps the existing task auto-done setting and says --auto-done was not applied', async () => {
  const requeue = setup({ taskId: 'old', reason: 'same PR' }, 'requeue');
  await schedule(requeue.deps, parseScheduleArgs(['--auto-done', '/review-pr', '17741']));
  assert.ok(
    requeue.printed.some((line) => line.startsWith('old keeps its auto-done setting (off); --auto-done applies')),
  );
});

test('--agent is checked and sent for a plain task and for a repeat', async () => {
  assert.equal(parseScheduleArgs(['--agent', 'reviewer', 'x']).agent, 'reviewer');
  assert.equal(parseScheduleArgs(['x']).agent, undefined);
  for (const bad of ['Reviewer', 'a b', '-x', 'a'.repeat(33), '../x', 'a;ls'])
    assert.throws(() => parseScheduleArgs(['--agent', bad, 'x']), /is not an agent name/, bad);

  const plain = setup(undefined);
  const created = (await schedule(plain.deps, parseScheduleArgs(['--agent', 'reviewer', '--new', '/sweep'])))?.task;
  assert.equal(created?.agent, 'reviewer');
  const none = setup(undefined);
  assert.equal((await schedule(none.deps, parseScheduleArgs(['--new', '/sweep'])))?.task.agent ?? null, null);

  const repeat = setup(undefined);
  const first = (await schedule(repeat.deps, parseScheduleArgs(['--agent', 'sweeper', '--every', '2h', '/sweep'], NOW)))
    ?.task;
  assert.equal(first?.agent, 'sweeper');
  assert.ok(repeat.backend.writes[0]?.endsWith('| here:/work/cosuno | agent sweeper'));
});

test('only a task with the same agent can be a duplicate of a new one', async () => {
  const seen: string[][] = [];
  const make = (agent: string | null) => {
    const made = setup({ taskId: 'old', reason: 'same PR' }, 'abort');
    Object.assign(made.backend.tasks[0]!, { agent });
    made.deps.check = async (_prompt, _dir, open) => {
      seen.push(open.map((task) => task.id));
      return undefined;
    };
    return made;
  };
  await schedule(make('reviewer').deps, parseScheduleArgs(['--agent', 'reviewer', '/review-pr', '17741']));
  await schedule(make('reviewer').deps, parseScheduleArgs(['--agent', 'writer', '/review-pr', '17741']));
  await schedule(make('reviewer').deps, parseScheduleArgs(['/review-pr', '17741']));
  await schedule(make(null).deps, parseScheduleArgs(['--agent', 'reviewer', '/review-pr', '17741']));
  await schedule(make(null).deps, parseScheduleArgs(['/review-pr', '17741']));
  assert.deepEqual(seen, [['old'], [], [], [], ['old']]);
});

test('a requeue keeps the existing task effort and says --effort was not applied', async () => {
  const requeue = setup({ taskId: 'old', reason: 'same PR' }, 'requeue');
  await schedule(requeue.deps, parseScheduleArgs(['--effort', 'high', '/review-pr', '17741']));
  assert.ok(requeue.printed.includes('old keeps its effort (the default); --effort applies only to a new task'));
});

test('a requeue keeps the existing task model and says --model was not applied', async () => {
  const requeue = setup({ taskId: 'old', reason: 'same PR' }, 'requeue');
  await schedule(requeue.deps, parseScheduleArgs(['--model', 'opus', '/review-pr', '17741']));
  assert.ok(requeue.printed.includes('old keeps its model (the default); --model applies only to a new task'));
  assert.ok(!requeue.backend.writes.some((w) => w.startsWith('create')));
});

test('--polish parks the task in Backlog; it cannot be combined with what keeps a task out of Backlog', () => {
  const args = parseScheduleArgs(['--polish', 'rough', 'idea']);
  assert.deepEqual([args.polish, args.backlog, args.hold, args.prompt], [true, true, false, 'rough idea']);
  assert.equal(parseScheduleArgs(['--polish', '--backlog', 'x']).backlog, true);
  for (const flags of [
    ['--hold'],
    ['--in', '2h'],
    ['--at', '09:30'],
    ['--every', '2h'],
    ['--cron', '0 9 * * 1-5'],
    ['--every', '2h', '--times', '3'],
  ])
    assert.throws(
      () => parseScheduleArgs(['--polish', ...flags, 'x']),
      new RegExp(`--polish .* cannot be combined with .*${flags[0]}`),
    );
  assert.throws(() => parseScheduleArgs(['--polish', '--until', '2099-01-01', 'x']), /--polish .* --until/);
});

test('--polish creates the task in Backlog and a polish task for it, placed in the same machine and directory', async () => {
  const { deps, backend, printed } = setup(undefined);
  const drafts: TaskDraft[] = [];
  const addTask = backend.addTask.bind(backend);
  backend.addTask = async (draft) => {
    drafts.push(draft);
    const added = await addTask(draft);
    return { ...added, task: { ...added.task, id: `t${drafts.length}` } };
  };
  const scheduled = await schedule(
    deps,
    parseScheduleArgs(['--polish', '--priority', 'high', '--title', 'Postal codes', 'export', 'postal', 'codes']),
  );
  assert.equal(scheduled?.task.status, 'backlog');
  assert.equal(scheduled?.polish?.id, 't2');
  const expected = polishTask({
    id: 't1',
    title: 'Postal codes',
    priority: 'high',
    machine: 'here',
    workdir: '/work/cosuno',
  });
  assert.deepEqual(drafts[1], {
    title: 'Polish prompt: Postal codes',
    input: expected.input,
    priority: 'high',
    parentId: 't1',
    createdBy: 'user',
    machine: 'here',
    workdir: '/work/cosuno',
  });
  assert.equal(drafts[1]?.status, undefined, 'the polish task runs from Todo');
  assert.match(drafts[1]?.input ?? '', /board polish t1 /);
  assert.ok(printed.some((line) => line === 'queued polish t2 https://board.test/t/t2'));
});

test('--polish queues no polish when the duplicate is requeued or the schedule dropped', async () => {
  const dup = { taskId: 'old', reason: 'same PR' };
  const requeue = setup(dup, 'requeue');
  const again = await schedule(requeue.deps, parseScheduleArgs(['--polish', '/review-pr', '17741']));
  assert.equal(again?.polish, undefined);
  assert.ok(requeue.backend.writes.includes('status old -> backlog'));
  assert.ok(!requeue.backend.writes.some((w) => w.startsWith('create')));
  assert.ok(requeue.printed.some((line) => line.startsWith('no polish queued for old')));

  const abort = setup(dup, 'abort');
  assert.equal(await schedule(abort.deps, parseScheduleArgs(['--polish', '/review-pr', '17741'])), undefined);
  assert.deepEqual(abort.backend.writes, []);
});

const PR = 'https://github.com/o/r/pull/7';
const KEYED = ['--agent', 'reviewer', '--key', PR, '--version', 'sha2', '/review-pr', PR, '--auto'];

// A board with one task made for PR 7 at `sha1`, whose key is the PR URL, and a check that must never be asked.
function keyedSetup(existing: Partial<ReturnType<typeof task>> = {}) {
  const old = task({
    id: 'old',
    input: `/review-pr ${PR} --auto`,
    status: 'needs-me',
    head: 'sha1',
    agent: 'reviewer',
    ...existing,
  });
  const { deps, backend, printed } = setup(undefined);
  backend.tasks.splice(0, backend.tasks.length, old);
  backend.keys.set('old', PR);
  deps.check = async () => {
    throw new Error('the duplicate check must not run with --key');
  };
  return { deps, backend, printed, old };
}

test('--key with --version creates the task with its head, without the duplicate check', async () => {
  const { deps, backend, printed } = keyedSetup();
  const outcome = await schedule(
    deps,
    parseScheduleArgs(['--agent', 'reviewer', '--key', 'other', '--version', 'sha9', 'x']),
  );
  assert.deepEqual(outcome?.keyed, { result: 'created' });
  assert.equal(outcome?.task.head, 'sha9');
  assert.equal(outcome?.task.agent, 'reviewer');
  assert.deepEqual(printed, ['created new https://board.test/t/new']);
  assert.ok(backend.writes[0]?.endsWith('| key other'));
});

test('--key finds the task of the same key: the same version, no version, or a task that is busy changes nothing', async () => {
  const same = keyedSetup({ head: 'sha2' });
  const outcome = await schedule(same.deps, parseScheduleArgs(KEYED));
  assert.deepEqual(outcome?.keyed, { result: 'exists', reason: 'same-version' });
  assert.deepEqual(same.printed, ['exists old https://board.test/t/old (same-version)']);

  const none = keyedSetup();
  assert.deepEqual((await schedule(none.deps, parseScheduleArgs(['--agent', 'reviewer', '--key', PR, 'x'])))?.keyed, {
    result: 'exists',
    reason: 'no-version',
  });

  for (const status of ['todo', 'running', 'waiting', 'backlog'] as const) {
    const busy = keyedSetup({ status });
    assert.deepEqual((await schedule(busy.deps, parseScheduleArgs(KEYED)))?.keyed, {
      result: 'exists',
      reason: 'busy',
    });
    assert.equal(busy.backend.tasks[0]?.head, 'sha1');
  }
  for (const setupResult of [same, none]) assert.ok(!setupResult.backend.writes.some((w) => w.startsWith('status')));
});

test('a closed task is never made again, whatever the version', async () => {
  const { deps, backend } = keyedSetup({ closed: true, status: 'done' });
  assert.deepEqual((await schedule(deps, parseScheduleArgs(KEYED)))?.keyed, { result: 'exists', reason: 'closed' });
  assert.equal(backend.tasks[0]?.status, 'done');
});

test('a new version requeues a task from Needs me or Done, or one without a head, in one expecting update', async () => {
  for (const [status, head] of [
    ['needs-me', 'sha1'],
    ['done', 'sha1'],
    ['done', null],
  ] as const) {
    const { deps, backend, printed } = keyedSetup({ status, head });
    const outcome = await schedule(deps, parseScheduleArgs(KEYED));
    assert.deepEqual(outcome?.keyed, { result: 'requeued' });
    assert.deepEqual(
      [backend.tasks[0]?.status, backend.tasks[0]?.head, backend.tasks[0]?.next],
      ['todo', 'sha2', 'fresh'],
    );
    assert.deepEqual(
      backend.writes.filter((w) => w.startsWith('status') || w.startsWith('note')),
      ['status old -> todo', 'note old (system): New version sha2. Queued again.'],
    );
    assert.deepEqual(printed, ['requeued old https://board.test/t/old']);
  }
});

const SESSION = '3f2b6c1e-8d4a-4e0b-9a57-1c2d3e4f5a6b';

function recordingSpool(events: string[]) {
  return {
    put: (taskId: string, prompt: string) => void events.push(`put ${taskId}: ${prompt}`),
    drop: (taskId: string) => void events.push(`drop ${taskId}`),
  };
}

test('a requeue with an update prompt resumes the session: the prompt is spooled before the move and shown in the note', async () => {
  const { deps, backend } = keyedSetup({ status: 'done', sessionId: SESSION });
  const events: string[] = [];
  const updateTask = backend.updateTask.bind(backend);
  backend.updateTask = async (id, patch) => {
    events.push('update');
    return updateTask(id, patch);
  };
  const outcome = await scheduleKeyed(deps, parseScheduleArgs(KEYED), PR, {
    prompt: 'Review it again.',
    spool: recordingSpool(events),
  });
  assert.deepEqual(outcome.keyed, { result: 'requeued' });
  assert.deepEqual(events, ['put old: Review it again.', 'update']);
  assert.equal(backend.tasks[0]?.next, 'resume');
  assert.ok(
    backend.writes.includes(
      'note old (system): New version sha2. Queued again to resume its session.\n\nReview it again.',
    ),
  );
});

test('a requeue with an update prompt but no session starts fresh and spools nothing', async () => {
  const { deps, backend } = keyedSetup({ status: 'done', sessionId: null });
  const events: string[] = [];
  await scheduleKeyed(deps, parseScheduleArgs(KEYED), PR, {
    prompt: 'Review it again.',
    spool: recordingSpool(events),
  });
  assert.deepEqual(events, []);
  assert.equal(backend.tasks[0]?.next, 'fresh');
  assert.ok(backend.writes.includes('note old (system): New version sha2. Queued again.'));
});

test('a refused requeue drops the spooled update prompt', async () => {
  const { deps, backend } = keyedSetup({ status: 'done', sessionId: SESSION });
  backend.updateTask = async () => {
    throw new BackendError('the task moved', 409);
  };
  const events: string[] = [];
  const outcome = await scheduleKeyed(deps, parseScheduleArgs(KEYED), PR, {
    prompt: 'Review it again.',
    spool: recordingSpool(events),
  });
  assert.deepEqual(outcome.keyed, { result: 'exists', reason: 'changed' });
  assert.deepEqual(events, ['put old: Review it again.', 'drop old']);

  backend.updateTask = async () => {
    throw new Error('the board is down');
  };
  events.length = 0;
  await assert.rejects(
    scheduleKeyed(deps, parseScheduleArgs(KEYED), PR, { prompt: 'Review it again.', spool: recordingSpool(events) }),
    /the board is down/,
  );
  assert.deepEqual(events, ['put old: Review it again.', 'drop old']);
});

test('a task of another agent, or one whose agent is unreadable, is not requeued', async () => {
  for (const existing of [
    { agent: undefined },
    { agent: 'other' },
    { agent: undefined, unreadable: ['agent' as const] },
  ]) {
    const { deps, backend } = keyedSetup(existing);
    assert.deepEqual((await schedule(deps, parseScheduleArgs(KEYED)))?.keyed, {
      result: 'exists',
      reason: 'other-agent',
    });
    assert.equal(backend.tasks[0]?.status, 'needs-me');
    assert.ok(!backend.writes.some((w) => w.startsWith('status') || w.startsWith('note')));
  }
  const plain = keyedSetup({ agent: undefined });
  const outcome = await schedule(plain.deps, parseScheduleArgs(['--key', PR, '--version', 'sha2', 'x']));
  assert.deepEqual(outcome?.keyed, { result: 'requeued' }, 'no agent on either side is the same agent');
});

test('a task that moved since it was read is left alone: exists (changed)', async () => {
  const { deps, backend, printed } = keyedSetup();
  const addTask = backend.addTask.bind(backend);
  backend.addTask = async (draft) => {
    const found = await addTask(draft);
    backend.tasks[0]!.status = 'running';
    return found;
  };
  assert.deepEqual((await schedule(deps, parseScheduleArgs(KEYED)))?.keyed, { result: 'exists', reason: 'changed' });
  assert.deepEqual(printed, ['exists old https://board.test/t/old (changed)']);
  assert.ok(!backend.writes.some((w) => w.startsWith('note')));
  assert.equal(backend.tasks[0]?.head, 'sha1');
});

test('another failure of the requeue is not swallowed', async () => {
  const { deps, backend } = keyedSetup();
  backend.updateTask = async () => {
    throw new BackendError('update-task: the server answered 500', 500);
  };
  await assert.rejects(schedule(deps, parseScheduleArgs(KEYED)), /answered 500/);
});

test('--key and --version are checked, and refuse what they cannot go with', () => {
  assert.equal(parseScheduleArgs(['--key', PR, '--version', 'abc', 'x']).key, PR);
  assert.equal(parseScheduleArgs(['--key', ` ${PR}`, 'x']).key, ` ${PR}`, 'the key is used as given');
  assert.throws(() => parseScheduleArgs(['--key', '  ', 'x']), /--key must not be empty/);
  assert.throws(() => parseScheduleArgs(['--key', 'a\nb', 'x']), /--key must not contain control characters/);
  assert.throws(() => parseScheduleArgs(['--key', 'a\u2028b', 'x']), /control characters/);
  assert.throws(() => parseScheduleArgs(['--key', 'k'.repeat(501), 'x']), /--key is longer than 500/);
  assert.throws(() => parseScheduleArgs(['--key', 'k', '--version', '', 'x']), /--version must not be empty/);
  assert.throws(() => parseScheduleArgs(['--key', 'k', '--version', 'v\u001b[0m', 'x']), /--version must not contain/);
  assert.throws(
    () => parseScheduleArgs(['--key', 'k', '--version', 'v'.repeat(201), 'x']),
    /--version is longer than 200/,
  );
  assert.throws(() => parseScheduleArgs(['--version', 'v', 'x']), /--version belongs to --key/);
  for (const flags of [['--every', '2h'], ['--cron', '0 9 * * *'], ['--polish'], ['--hold'], ['--backlog']])
    assert.throws(() => parseScheduleArgs(['--key', 'k', ...flags, 'x'], NOW), /--key makes or finds one task in Todo/);
});

const LATER = new Date('2030-01-01T10:00:00Z');
const WAIT = ['--at', '2030-01-01T10:00:00Z'];

test('--key with --at creates the task in Todo with its start time', async () => {
  const { deps, backend, printed } = keyedSetup();
  const outcome = await schedule(deps, parseScheduleArgs(['--key', 'other', ...WAIT, 'x'], NOW));
  assert.deepEqual(outcome?.keyed, { result: 'created' });
  assert.equal(outcome?.task.notBefore?.getTime(), LATER.getTime());
  assert.match(printed[0] ?? '', /^created new https:\/\/board\.test\/t\/new, starts /);
  assert.ok(backend.writes[0]?.endsWith('| key other'));
});

test('a waiting task of the key moves its start time, with the version, the same version or none', async () => {
  for (const [args, head, notes] of [
    [KEYED, 'sha1', ['note old (system): New version sha2. Starts']],
    [KEYED, 'sha2', []],
    [['--agent', 'reviewer', '--key', PR, 'x'], 'sha1', []],
  ] as const) {
    const { deps, backend, printed } = keyedSetup({ status: 'todo', next: 'fresh', head });
    const outcome = await schedule(deps, parseScheduleArgs([...WAIT, ...args], NOW));
    assert.deepEqual(outcome?.keyed, { result: 'rescheduled' });
    assert.equal(backend.tasks[0]?.notBefore?.getTime(), LATER.getTime());
    assert.equal(backend.tasks[0]?.head, args === KEYED ? 'sha2' : head);
    assert.deepEqual(
      backend.writes
        .filter((w) => w.startsWith('note'))
        .map((w) => w.slice(0, 'note old (system): New version sha2. Starts'.length)),
      notes,
    );
    assert.ok(!backend.writes.some((w) => w.startsWith('status')));
    assert.match(printed[0] ?? '', /^rescheduled old https:\/\/board\.test\/t\/old, starts /);
  }
});

test('a reschedule that finds the task moved is exists (changed)', async () => {
  const { deps, backend, printed } = keyedSetup({ status: 'todo', next: 'fresh' });
  const addTask = backend.addTask.bind(backend);
  backend.addTask = async (draft) => {
    const found = await addTask(draft);
    backend.tasks[0]!.status = 'running';
    return found;
  };
  assert.deepEqual((await schedule(deps, parseScheduleArgs([...WAIT, ...KEYED], NOW)))?.keyed, {
    result: 'exists',
    reason: 'changed',
  });
  assert.deepEqual(printed, ['exists old https://board.test/t/old (changed)']);
  assert.equal(backend.tasks[0]?.notBefore ?? null, null);
});

test('a Todo task that resumes, or runs as another agent, or has no start time given, is not rescheduled', async () => {
  const resume = keyedSetup({ status: 'todo', next: 'resume' });
  assert.deepEqual((await schedule(resume.deps, parseScheduleArgs([...WAIT, ...KEYED], NOW)))?.keyed, {
    result: 'exists',
    reason: 'busy',
  });
  const other = keyedSetup({ status: 'todo', next: 'fresh', agent: 'other' });
  assert.deepEqual((await schedule(other.deps, parseScheduleArgs([...WAIT, ...KEYED], NOW)))?.keyed, {
    result: 'exists',
    reason: 'busy',
  });
  const plain = keyedSetup({ status: 'todo', next: 'fresh' });
  assert.deepEqual((await schedule(plain.deps, parseScheduleArgs(KEYED)))?.keyed, { result: 'exists', reason: 'busy' });
  const none = keyedSetup({ status: 'todo', next: 'fresh' });
  assert.deepEqual((await schedule(none.deps, parseScheduleArgs(['--agent', 'reviewer', '--key', PR, 'x'])))?.keyed, {
    result: 'exists',
    reason: 'no-version',
  });
  for (const { backend } of [resume, other, plain, none]) {
    assert.equal(backend.tasks[0]?.notBefore ?? null, null);
    assert.ok(!backend.writes.some((w) => w.startsWith('notBefore')));
  }
});

test('a requeue with --at also sets the start time', async () => {
  const { deps, backend, printed } = keyedSetup();
  const outcome = await schedule(deps, parseScheduleArgs([...WAIT, ...KEYED], NOW));
  assert.deepEqual(outcome?.keyed, { result: 'requeued' });
  assert.equal(backend.tasks[0]?.notBefore?.getTime(), LATER.getTime());
  assert.match(printed[0] ?? '', /^requeued old https:\/\/board\.test\/t\/old, starts /);
  assert.match(backend.writes.find((w) => w.startsWith('note')) ?? '', /Queued again, starts /);
});

test('the key reaches the board as the blind index of the PR URL', async () => {
  const sent: (string | undefined)[] = [];
  const { deps, backend } = keyedSetup();
  const addTask = backend.addTask.bind(backend);
  backend.addTask = async (draft) => (sent.push(draft.dedupeKey), addTask(draft));
  await schedule(deps, parseScheduleArgs(KEYED));
  assert.deepEqual(sent, [PR], 'the sealing backend turns the key into the index the board holds for it');
  assert.equal(await dedupeKeyIndex(KEYS, sent[0] ?? ''), await dedupeKeyIndex(KEYS, PR));
  assert.match(await headIndex(KEYS, 'sha2'), /^abh1\./);
});
