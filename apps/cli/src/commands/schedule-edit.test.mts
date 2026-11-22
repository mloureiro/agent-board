import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { Schedule, ScheduleSettings, Task } from '@agent-board/shared';
import type { Config } from '../config/config.mts';
import type { LinkingContext } from '../cli.mts';
import { CONFIG, fakeBackend, linkTo, schedule, task } from '../__tests__/helpers/fakes.mts';
import { runBoard } from './program.mts';
import type { ProgramOptions } from './program-shared.mts';
import { parseScheduleChanges } from './schedule-edit.mts';

const NOW = new Date('2027-01-01T10:00:00Z');

function runner(
  schedules: Schedule[],
  tasks: Task[] = [task({ id: 'pending', scheduleId: 's1' })],
  config: Config = CONFIG,
) {
  const backend = fakeBackend(tasks);
  backend.schedules.push(...schedules);
  const printed: string[] = [];
  const makeContext = (dryRun: boolean): LinkingContext => ({
    config,
    backend,
    dryRun,
    taskLink: linkTo,
    print: (line) => printed.push(line),
  });
  return {
    backend,
    printed,
    go: (argv: string[], overrides: ProgramOptions = {}) =>
      runBoard(argv, { env: {}, context: makeContext, writeOut: () => {}, writeErr: () => {}, ...overrides }),
  };
}

// The settings the last edit sent, as the fake backend recorded them.
function sentSettings(run: ReturnType<typeof runner>): ScheduleSettings {
  const line = run.backend.writes.findLast((write) => write.includes(' settings: '));
  assert.ok(line, 'no settings were sent');
  return JSON.parse(line.slice(line.indexOf(' settings: ') + ' settings: '.length)) as ScheduleSettings;
}

function directory(context: TestContext): string {
  const dir = realpathSync(mkdtempSync('/tmp/board-schedule-edit-test-'));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const BASE = {
  priority: 'normal',
  model: null,
  autoDone: false,
  place: null,
  repeat: { everyMs: 7_200_000 },
  runsLeft: null,
  until: null,
  maxConcurrent: null,
};

test('a setting flag sends every setting, the unchanged ones taken from the schedule', async () => {
  const current = schedule({
    id: 's1',
    priority: 'low',
    model: 'sonnet',
    autoDone: true,
    machine: 'here',
    workdir: '/work/repo',
    agent: 'reviewer',
    maxConcurrent: 3,
    remaining: 4,
  });
  const run = runner([current]);
  await run.go(['schedules', 'edit', 's1', '--priority', 'high']);
  assert.deepEqual(sentSettings(run), {
    agent: 'reviewer',
    place: { machine: 'here', workdir: '/work/repo' },
    priority: 'high',
    model: 'sonnet',
    autoDone: true,
    repeat: { everyMs: 7_200_000 },
    runsLeft: 5,
    until: null,
    maxConcurrent: 3,
  });
  assert.deepEqual(run.backend.writes[0], 'edit-schedule s1: schedule s1 | /sweep');
  assert.deepEqual(run.printed, ['s1 updated: priority high. The pending card was updated too.']);
});

test('default, off and none clear a model, auto-done, the agent, the directory and the limit', async () => {
  const run = runner([
    schedule({
      id: 's1',
      model: 'opus',
      autoDone: true,
      agent: 'reviewer',
      machine: 'here',
      workdir: '/work/repo',
      maxConcurrent: 2,
    }),
  ]);
  await run.go([
    'schedules',
    'edit',
    's1',
    '--model',
    'default',
    '--auto-done',
    'off',
    '--agent',
    'none',
    '--dir',
    'none',
    '--max-concurrent',
    'none',
  ]);
  assert.deepEqual(sentSettings(run), BASE);
  assert.deepEqual(run.printed, [
    's1 updated: agent none, no directory, model default, auto-done off, no concurrency limit. The pending card was updated too.',
  ]);
});

test('--effort sends the level, default sends null, and a schedule without one sends none', async () => {
  const run = runner([schedule({ id: 's1' })]);
  await run.go(['schedules', 'edit', 's1', '--effort', 'xhigh']);
  assert.deepEqual(sentSettings(run), { ...BASE, effort: 'xhigh' });
  assert.deepEqual(run.printed, ['s1 updated: effort xhigh. The pending card was updated too.']);
  const keeping = runner([schedule({ id: 's1', effort: 'low' })]);
  await keeping.go(['schedules', 'edit', 's1', '--priority', 'high']);
  assert.deepEqual(sentSettings(keeping), { ...BASE, priority: 'high', effort: 'low' });
  await keeping.go(['schedules', 'edit', 's1', '--effort', 'default']);
  assert.deepEqual(sentSettings(keeping), { ...BASE, priority: 'high', effort: null });
  assert.deepEqual(keeping.printed[1], 's1 updated: effort default. The pending card was updated too.');
  await assert.rejects(run.go(['schedules', 'edit', 's1', '--effort', 'huge']), /unknown effort "huge"/);
});

test('--icon sends the emoji, none sends null, and without the flag or the same icon no icon is sent', async () => {
  const run = runner([schedule({ id: 's1' })]);
  await run.go(['schedules', 'edit', 's1', '--icon', '🧹']);
  assert.deepEqual(sentSettings(run), { ...BASE, icon: '🧹' });
  assert.deepEqual(run.printed, ['s1 updated: icon 🧹. The pending card was updated too.']);
  await run.go(['schedules', 'edit', 's1', '--priority', 'high']);
  assert.deepEqual(sentSettings(run), { ...BASE, priority: 'high' });
  await run.go(['schedules', 'edit', 's1', '--icon', '🧹']);
  assert.equal(run.printed.at(-1), 's1 already has these settings');
  await run.go(['schedules', 'edit', 's1', '--icon', 'none']);
  assert.deepEqual(sentSettings(run), { ...BASE, priority: 'high', icon: null });
  assert.equal(run.printed.at(-1), 's1 updated: icon none. The pending card was updated too.');
  await assert.rejects(run.go(['schedules', 'edit', 's1', '--icon', 'broom']), /not an icon: give one emoji/);
});

test('--label replaces the labels, none alone removes them, and the same labels send nothing', async () => {
  const run = runner([schedule({ id: 's1' })]);
  await run.go(['schedules', 'edit', 's1', '--label', 'chore', '--label', 'nightly']);
  assert.deepEqual(sentSettings(run), { ...BASE, labels: ['chore', 'nightly'] });
  assert.deepEqual(run.printed, ['s1 updated: labels chore, nightly. The pending card was updated too.']);
  await run.go(['schedules', 'edit', 's1', '--label', 'chore', '--label', 'nightly']);
  assert.equal(run.printed.at(-1), 's1 already has these settings');
  await run.go(['schedules', 'edit', 's1', '--label', 'none']);
  assert.deepEqual(sentSettings(run), { ...BASE, labels: [] });
  assert.equal(run.printed.at(-1), 's1 updated: labels none. The pending card was updated too.');
  await assert.rejects(run.go(['schedules', 'edit', 's1', '--label', '-x']), /not a label/);
});

test('--lane sends the lane, default sends null, and without the flag no lane is sent', async () => {
  const run = runner([schedule({ id: 's1', requestedLane: 'old' })]);
  await run.go(['schedules', 'edit', 's1', '--lane', 'review']);
  assert.equal(sentSettings(run).lane, 'review');
  assert.deepEqual(run.printed, ['s1 updated: lane review. The pending card was updated too.']);
  await run.go(['schedules', 'edit', 's1', '--lane', 'default']);
  assert.equal(sentSettings(run).lane, null);
  assert.equal(run.printed.at(-1), 's1 updated: lane default. The pending card was updated too.');
  await run.go(['schedules', 'edit', 's1', '--priority', 'high']);
  assert.equal('lane' in sentSettings(run), false);
});

test('--lane with the lane the schedule has already changes nothing, and a bad name is refused', async () => {
  const run = runner([schedule({ id: 's1', requestedLane: 'review' }), schedule({ id: 's2' })]);
  await run.go(['schedules', 'edit', 's1', '--lane', 'review']);
  await run.go(['schedules', 'edit', 's2', '--lane', 'default']);
  assert.deepEqual(run.printed, ['s1 already has these settings', 's2 already has these settings']);
  assert.deepEqual(run.backend.writes, []);
  await assert.rejects(run.go(['schedules', 'edit', 's1', '--lane', 'a b']), /is not a lane name/);
  assert.deepEqual(run.backend.writes, []);
});

test('a new repeat replaces the old rule, with the time zone of this machine for cron', async () => {
  const run = runner([
    schedule({ id: 's1', everyMs: null, cron: '0 9 * * *', moreCrons: ['0 17 * * *'], timezone: 'UTC' }),
  ]);
  await run.go(['schedules', 'edit', 's1', '--every', '6h']);
  assert.deepEqual(sentSettings(run).repeat, { everyMs: 21_600_000 });
  await run.go(['schedules', 'edit', 's1', '--cron', '0 8 * * 1', '--cron', '0 12 * * 1']);
  assert.deepEqual(sentSettings(run).repeat, {
    cron: '0 8 * * 1',
    moreCrons: ['0 12 * * 1'],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  await run.go(['schedules', 'edit', 's1', '--cron', '0 8 * * 2']);
  assert.deepEqual(sentSettings(run).repeat, {
    cron: '0 8 * * 2',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
});

test('a cron schedule keeps its expressions and time zone when something else changes', async () => {
  const run = runner([
    schedule({ id: 's1', everyMs: null, cron: '0 9 * * *', moreCrons: ['0 17 * * *'], timezone: 'Europe/Berlin' }),
  ]);
  await run.go(['schedules', 'edit', 's1', '--priority', 'high']);
  assert.deepEqual(sentSettings(run).repeat, {
    cron: '0 9 * * *',
    moreCrons: ['0 17 * * *'],
    timezone: 'Europe/Berlin',
  });
});

test('--after resolves the schedule, with a delay, and --delay alone changes the delay of an after-schedule', async () => {
  const run = runner(
    [schedule({ id: 's1' }), schedule({ id: 'upstream1', title: 'Build' })],
    [task({ id: 'pending', scheduleId: 's1' })],
  );
  await run.go(['schedules', 'edit', 's1', '--after', 'upstr', '--delay', '10m']);
  assert.deepEqual(sentSettings(run).repeat, { after: { scheduleId: 'upstream1', delayMs: 600_000 } });
  assert.deepEqual(run.printed, [
    's1 updated: repeat after upstream1 +10m. The pending card was removed; the next one is made when a card of the schedule it runs after finishes.',
  ]);
  await run.go(['schedules', 'edit', 's1', '--delay', '1h']);
  assert.deepEqual(sentSettings(run).repeat, { after: { scheduleId: 'upstream1', delayMs: 3_600_000 } });
  // The same upstream again keeps the delay it has.
  await run.go(['schedules', 'edit', 's1', '--after', 'upstream1', '--priority', 'high']);
  assert.deepEqual(sentSettings(run).repeat, { after: { scheduleId: 'upstream1', delayMs: 3_600_000 } });
  await run.go(['schedules', 'edit', 's1', '--every', '2h']);
  assert.equal(run.printed.at(-1), "s1 updated: repeat every 2h. A card now waits for the schedule's next run.");
});

test('the first run comes from --in or --at, and an after-schedule has none', async () => {
  const run = runner([
    schedule({ id: 's1' }),
    schedule({ id: 'after001', everyMs: null, after: { scheduleId: 's1', delayMs: 0 } }),
  ]);
  await run.go(['schedules', 'edit', 's1', '--at', '2030-01-01T09:00']);
  const withAt = run.backend.writes.findLast((write) => write.includes(' settings: '))!;
  assert.match(withAt, /"at":"2030-01-01T0\d:00:00.000Z"/);
  await assert.rejects(run.go(['schedules', 'edit', 'after001', '--in', '1h']), /not one that runs after another/);
  await assert.rejects(
    run.go(['schedules', 'edit', 's1', '--after', 'after001', '--at', '2030-01-01']),
    /not one that runs after another/,
  );
});

test('--times counts the waiting run, --until and --forever replace the end, and each clears the other', async () => {
  const run = runner([schedule({ id: 's1', remaining: 4 })]);
  await run.go(['schedules', 'edit', 's1', '--max-concurrent', '2']);
  assert.equal(sentSettings(run).runsLeft, 5);
  await run.go(['schedules', 'edit', 's1', '--times', '3']);
  assert.deepEqual([sentSettings(run).runsLeft, sentSettings(run).until], [3, null]);
  await run.go(['schedules', 'edit', 's1', '--until', '2030-01-01']);
  assert.deepEqual([sentSettings(run).runsLeft, typeof sentSettings(run).until], [null, 'string']);
  await run.go(['schedules', 'edit', 's1', '--forever']);
  assert.deepEqual([sentSettings(run).runsLeft, sentSettings(run).until], [null, null]);
});

test('--dir pins to this machine and a directory this machine lists; an unlisted one is refused', async (context) => {
  const dir = directory(context);
  const other = directory(context);
  mkdirSync(join(dir, 'sub'));
  const config: Config = { ...CONFIG, dirs: [{ path: dir }] };
  const run = runner([schedule({ id: 's1' })], undefined, config);
  await run.go(['schedules', 'edit', 's1', '--dir', join(dir, 'sub')], { cwd: other });
  assert.deepEqual(sentSettings(run).place, { machine: 'here', workdir: join(dir, 'sub') });
  await run.go(['schedules', 'edit', 's1', '--dir', 'sub'], { cwd: dir });
  assert.deepEqual(sentSettings(run).place, { machine: 'here', workdir: join(dir, 'sub') });
  await assert.rejects(run.go(['schedules', 'edit', 's1', '--dir', other]), /not a listed directory on here/);
  await assert.rejects(run.go(['schedules', 'edit', 's1', '--dir', join(dir, 'missing')]), /is not a directory/);
});

test('--agent needs the agent in this machine’s config when the schedule runs here, and not when it runs elsewhere', async () => {
  const config: Config = {
    ...CONFIG,
    agents: {
      reviewer: { description: 'r', tools: ['Read'], allowedTools: [], disallowedTools: [], env: [], mcpServers: [] },
    },
  };
  const here = runner([schedule({ id: 's1', machine: 'here', workdir: '/w' })], undefined, config);
  await here.go(['schedules', 'edit', 's1', '--agent', 'reviewer']);
  assert.equal(sentSettings(here).agent, 'reviewer');
  await assert.rejects(
    here.go(['schedules', 'edit', 's1', '--agent', 'ghost']),
    /no agents.ghost in config.json on here/,
  );
  const elsewhere = runner([schedule({ id: 's1', machine: 'other', workdir: '/w' })], undefined, config);
  await elsewhere.go(['schedules', 'edit', 's1', '--agent', 'ghost']);
  assert.equal(sentSettings(elsewhere).agent, 'ghost');
  const anywhere = runner([schedule({ id: 's1' })], undefined, config);
  await anywhere.go(['schedules', 'edit', 's1', '--agent', 'ghost']);
  assert.equal(sentSettings(anywhere).agent, 'ghost');
});

test('the prompt is optional with a setting flag, and a prompt and settings go in one edit', async () => {
  const run = runner([schedule({ id: 's1', title: 'Sweep', input: '/sweep' })]);
  await run.go(['schedules', 'edit', 's1', '--title', 'Nightly', '--priority', 'high', '/sweep', 'more']);
  assert.equal(run.backend.writes[0], 'edit-schedule s1: Nightly | /sweep more');
  assert.equal(sentSettings(run).priority, 'high');
  assert.deepEqual(run.printed, ['s1 updated: title, prompt, priority high. The pending card was updated too.']);
});

test('nothing to change prints so and writes nothing', async () => {
  const run = runner([schedule({ id: 's1', priority: 'low', remaining: 2 })]);
  await run.go(['schedules', 'edit', 's1', '--priority', 'low', '--model', 'default', '--times', '3', '--every', '2h']);
  assert.deepEqual(run.backend.writes, []);
  assert.deepEqual(run.printed, ['s1 already has these settings']);
});

test('refuses conflicts, bad values, settings flags with another action, an ended and an unreadable schedule', async () => {
  const run = runner([
    schedule({ id: 's1' }),
    schedule({ id: 'self0001' }),
    schedule({ id: 'ended001', ended: true }),
    schedule({ id: 'bad00001', unreadable: ['workdir'] }),
  ]);
  const refuse = (args: string[], message: RegExp): Promise<void> =>
    assert.rejects(run.go(['schedules', 'edit', 's1', ...args]), message, args.join(' '));
  await refuse(['--every', '2h', '--cron', '0 9 * * *'], /--every, --cron cannot be combined/);
  await refuse(['--cron', '0 9 * * *', '--after', 'abc'], /--cron, --after cannot be combined/);
  await refuse(['--in', '1h', '--at', '09:00'], /--in, --at cannot be combined/);
  await refuse(['--times', '3', '--until', '2030-01-01'], /--times, --until cannot be combined/);
  await refuse(['--times', '3', '--forever'], /--times, --forever cannot be combined/);
  await refuse(['--delay', '1h'], /--delay belongs to --after/);
  await refuse(['--every', '2h', '--delay', '1h'], /--delay belongs to --after/);
  await refuse(['--priority', 'urgent!'], /unknown priority/);
  await refuse(['--auto-done', 'yes'], /--auto-done takes on or off/);
  await refuse(['--agent', 'a b'], /is not an agent name/);
  await refuse(['--cron', 'nonsense'], /5 fields/);
  await refuse(['--max-concurrent', '101'], /1 to 100/);
  await refuse(['--times', '0'], /positive whole number/);
  await refuse(['--until', '2020-01-01'], /is in the past/);
  await refuse(['--at', '2030-01-02', '--until', '2030-01-01'], /--until is before the first run/);
  await refuse(['--dir', ''], /takes a path, or none/);
  await assert.rejects(run.go(['schedules', 'edit', 'self0001', '--after', 'self0001']), /cannot run after itself/);
  await assert.rejects(run.go(['schedules', 'edit', 'ended001', '--priority', 'high']), /has ended/);
  await assert.rejects(run.go(['schedules', 'edit', 'bad00001', '--priority', 'high']), /cannot be decrypted/);
  await assert.rejects(run.go(['schedules', 'pause', 's1', '--priority', 'high']), /belong to board schedules edit/);
  await assert.rejects(run.go(['schedules', 'edit', 's1']), /text is missing/);
  assert.deepEqual(run.backend.writes, []);
});

test('the setting flags are refused inside a board run, which writes nothing', async () => {
  const run = runner([schedule({ id: 's1' })]);
  await assert.rejects(
    run.go(['schedules', 'edit', 's1', '--priority', 'high'], { env: { AGENT_BOARD_TASK: 'abc12345' } }),
    /not available inside a board run/,
  );
  assert.deepEqual(run.backend.writes, []);
});

test('parseScheduleChanges reads each flag once, with none, default and off as clears', () => {
  assert.deepEqual(
    parseScheduleChanges(
      { model: 'default', agent: 'none', dir: 'none', maxConcurrent: 'none', autoDone: 'off', forever: true },
      NOW,
    ),
    { model: null, agent: null, dir: null, maxConcurrent: null, autoDone: false, runsLeft: null, until: null },
  );
  assert.deepEqual(parseScheduleChanges({ in: '1h' }, NOW), { startAt: new Date('2027-01-01T11:00:00Z') });
  assert.deepEqual(parseScheduleChanges({ cron: ['0 9 * * *', ' 0 10 * * *'] }, NOW), {
    repeat: { crons: ['0 9 * * *', '0 10 * * *'] },
  });
  assert.deepEqual(parseScheduleChanges({ lane: 'default' }, NOW), { lane: null });
  assert.deepEqual(parseScheduleChanges({ effort: 'default' }, NOW), { effort: null });
  assert.deepEqual(parseScheduleChanges({ effort: 'max' }, NOW), { effort: 'max' });
  assert.deepEqual(parseScheduleChanges({ lane: 'review' }, NOW), { lane: 'review' });
  assert.deepEqual(parseScheduleChanges({}, NOW), {});
});

test('--dry-run is not a setting flag: the list, pause and a prompt-only edit still work with it', async () => {
  const run = runner([schedule({ id: 's1' })]);
  await run.go(['schedules', '--dry-run']);
  await run.go(['schedules', '--dry-run', 'pause', 's1']);
  await run.go(['schedules', '--dry-run', 'edit', 's1', 'a', 'new', 'prompt']);
  assert.equal(
    run.backend.writes.some((write) => write.includes(' settings: ')),
    false,
  );
});
