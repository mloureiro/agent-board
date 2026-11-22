import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { BackendError } from '../backend/backend.mts';
import { UsageError } from '../cli.mts';
import type { LinkingContext } from '../cli.mts';
import type { Config } from '../config/config.mts';
import { CONFIG, fakeBackend, linkTo, task } from '../__tests__/helpers/fakes.mts';
import { runBoard } from './program.mts';
import type { ProgramOptions } from './program-shared.mts';
import type { Task } from '@agent-board/shared';

interface Run {
  config: Config;
  backend: ReturnType<typeof fakeBackend>;
  printed: string[];
  out: string[];
  root: string;
  make: (name: string) => string;
  go: (argv: string[], overrides?: ProgramOptions) => Promise<void>;
}

// The `board` program over a fake backend, in a scratch directory that is its working directory.
function runner(context: TestContext, tasks: Task[], config: Partial<Config> = {}): Run {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'board-task-settings-test-')));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const backend = fakeBackend(tasks);
  const printed: string[] = [];
  const out: string[] = [];
  const merged: Config = { ...CONFIG, ...config };
  const makeContext = (dryRun: boolean): LinkingContext => ({
    config: merged,
    backend,
    dryRun,
    taskLink: linkTo,
    print: (line) => printed.push(line),
  });
  return {
    config: merged,
    backend,
    printed,
    out,
    root,
    make: (name) => {
      const path = join(root, name);
      mkdirSync(path, { recursive: true });
      return path;
    },
    go: (argv, overrides = {}) =>
      runBoard(argv, {
        env: {},
        context: makeContext,
        writeOut: (text) => out.push(text.trimEnd()),
        writeErr: (text) => printed.push(text.trimEnd()),
        cwd: root,
        ...overrides,
      }),
  };
}

const said = (run: Run): string => run.printed.join('\n');
const writes = (run: Run): string[] => run.backend.writes.filter((line) => !line.startsWith('dirs '));

test('board task prints the settings: null model and directory read as the default and the machine’s default directory', async (context) => {
  const run = runner(context, [task({ id: 'abc12345', title: 'Fix the export', createdBy: 'user' })]);
  await run.go(['task', 'abc12345']);
  assert.deepEqual(run.printed, [
    'abc12345  Fix the export',
    '  status      todo',
    '  priority    normal',
    '  model       default',
    '  effort      default',
    '  lane        default',
    '  auto-done   off',
    '  icon        none',
    '  labels      none',
    '  agent       none',
    '  created by  user',
    '  machine     any',
    '  directory   the default directory of the machine that takes it',
    '  starts      when a worker is free',
    '  schedule    none',
    '  session     starts fresh',
    '  pr          none',
  ]);
  assert.deepEqual(writes(run), []);
});

test('a pinned task with a session says so, and a directory this machine does not list is marked', async (context) => {
  const listed = { path: '/srv/other' };
  const run = runner(
    context,
    [
      task({
        id: 'abc12345',
        machine: 'here',
        workdir: '/srv/app',
        sessionId: 's1',
        next: 'resume',
        model: 'opus',
        agent: 'reviewer',
        scheduleId: 'sch1',
        prs: [{ id: 'p1', url: 'https://github.com/o/r/pull/1', state: null }],
        notBefore: new Date('2027-01-01T08:00:00Z'),
        status: 'needs-me',
        closed: true,
      }),
    ],
    { dirs: [listed] },
  );
  await run.go(['task', 'abc12345']);
  const text = said(run);
  assert.match(text, /status {6}needs-me \(closed\)/);
  assert.match(text, /model {7}opus/);
  assert.match(text, /agent {7}reviewer/);
  assert.match(text, /auto-done {3}off/);
  assert.match(text, /machine {5}here \(runs only there\)/);
  assert.match(text, /directory {3}\/srv\/app \(not listed on this machine\)/);
  assert.match(text, /schedule {4}sch1/);
  assert.match(text, /session {5}resumes its session/);
  assert.match(text, /pr {10}https:\/\/github.com\/o\/r\/pull\/1/);

  const elsewhere = runner(context, [task({ id: 'abc12345', machine: 'other', workdir: '/srv/app' })], {
    dirs: [listed],
  });
  await elsewhere.go(['task', 'abc12345']);
  assert.match(said(elsewhere), /machine {5}other \(runs only there\)\n {2}directory {3}\/srv\/app\n/);
});

test('control characters of the board’s values never reach the terminal, and an unreadable field is named', async (context) => {
  const run = runner(context, [
    task({
      id: 'abc12345',
      title: 'bad\u001b[31m title',
      model: 'x\u001b[2Jy',
      machine: 'm\u001bx',
      workdir: null,
      unreadable: ['workdir', 'agent'],
    }),
  ]);
  await run.go(['task', 'abc12345']);
  const text = said(run);
  assert.ok(!text.includes('\u001b'));
  assert.match(text, /directory {3}\(cannot decrypt\)/);
  assert.match(text, /agent {7}\(cannot decrypt\)/);
  assert.match(text, /\(cannot decrypt: workdir, agent\)/);
});

test('a fork names the task it was forked from in its settings and in --json, and a task that is none says nothing', async (context) => {
  const run = runner(context, [task({ id: 'abc12345', forkOf: 'par12345' }), task({ id: 'plain123' })]);
  await run.go(['task', 'abc12345']);
  assert.match(said(run), /fork of {5}par12345/);
  await run.go(['task', 'abc12345', '--json']);
  assert.equal((JSON.parse(run.out.join('\n')) as Record<string, unknown>)['forkOf'], 'par12345');
  run.printed.length = 0;
  await run.go(['task', 'plain123']);
  assert.doesNotMatch(said(run), /fork of/);
});

test('--json prints the task as `board tasks --json` does, and takes no action', async (context) => {
  const run = runner(context, [task({ id: 'abc12345', title: 'T', unreadable: ['input'] })]);
  await run.go(['task', 'abc12345', '--json']);
  const json = JSON.parse(run.out.join('\n')) as Record<string, unknown>;
  assert.deepEqual([json['id'], json['title'], json['input']], ['abc12345', 'T', null]);
  await assert.rejects(run.go(['task', 'abc12345', 'set', 'priority', 'high', '--json']), UsageError);
});

test('set priority changes it, says so, and is a no-op with "already" when it is the same', async (context) => {
  const run = runner(context, [task({ id: 'abc12345' })]);
  await run.go(['task', 'abc12345', 'set', 'priority', 'high']);
  assert.deepEqual(writes(run), ['priority abc12345: high']);
  assert.equal(said(run), 'abc12345 priority is now high');
  run.printed.length = 0;
  await run.go(['task', 'abc12345', 'set', 'priority', 'high']);
  assert.deepEqual(writes(run), ['priority abc12345: high']);
  assert.equal(said(run), 'abc12345 is already high');
  await assert.rejects(
    run.go(['task', 'abc12345', 'set', 'priority', 'soon']),
    /priority is one of urgent, high, normal, low/,
  );
  await assert.rejects(run.go(['task', 'abc12345', 'unset', 'priority']), UsageError);
});

test('set lane and unset lane change the lane the task asks for, and refuse a running task', async (context) => {
  const run = runner(context, [task({ id: 'abc12345' }), task({ id: 'run12345', status: 'running', lane: 'general' })]);
  await run.go(['task', 'abc12345', 'set', 'lane', 'reviews']);
  assert.equal(said(run), 'abc12345 asks for reviews from its next start on');
  assert.equal(run.backend.tasks[0]?.requestedLane, 'reviews');
  run.printed.length = 0;
  await run.go(['task', 'abc12345', 'set', 'lane', 'reviews']);
  assert.equal(said(run), 'abc12345 already asks for reviews');
  await run.go(['task', 'abc12345', 'unset', 'lane']);
  assert.equal(run.backend.tasks[0]?.requestedLane, null);
  assert.deepEqual(writes(run), ['lane abc12345: reviews', 'lane abc12345: default']);
  await assert.rejects(run.go(['task', 'abc12345', 'set', 'lane', 'not a lane']), /not a lane name/);
  await assert.rejects(run.go(['task', 'abc12345', 'set', 'lane']), UsageError);
  await assert.rejects(run.go(['task', 'run12345', 'set', 'lane', 'reviews']), /keeps its lane until its next start/);
  run.printed.length = 0;
  await run.go(['task', 'run12345']);
  assert.ok(run.printed.includes('  lane        default (running in general)'));
});

test('set model and unset model change the model from the next run on, in any status', async (context) => {
  const run = runner(context, [task({ id: 'abc12345', status: 'running' })]);
  await run.go(['task', 'abc12345', 'set', 'model', 'opus']);
  assert.match(said(run), /abc12345 uses opus from its next run on \(the run in progress keeps its model\)/);
  assert.equal(run.backend.tasks[0]?.model, 'opus');
  run.printed.length = 0;
  await run.go(['task', 'abc12345', 'set', 'model', 'opus']);
  assert.equal(said(run), 'abc12345 already uses opus');
  await run.go(['task', 'abc12345', 'unset', 'model']);
  assert.equal(run.backend.tasks[0]?.model, null);
  assert.deepEqual(writes(run), ['model abc12345: opus', 'model abc12345: default']);
  await assert.rejects(run.go(['task', 'abc12345', 'set', 'model', 'not a model']), /not a model name/);
  await assert.rejects(run.go(['task', 'abc12345', 'set', 'model']), UsageError);
});

test('set effort and unset effort change the effort from the next run on, in any status', async (context) => {
  const run = runner(context, [task({ id: 'abc12345', status: 'running' })]);
  await run.go(['task', 'abc12345', 'set', 'effort', 'xhigh']);
  assert.match(said(run), /abc12345 uses xhigh from its next run on \(the run in progress keeps its effort\)/);
  assert.equal(run.backend.tasks[0]?.effort, 'xhigh');
  run.printed.length = 0;
  await run.go(['task', 'abc12345', 'set', 'effort', 'xhigh']);
  assert.equal(said(run), 'abc12345 already uses xhigh');
  await run.go(['task', 'abc12345']);
  assert.match(said(run), /effort {6}xhigh/);
  await run.go(['task', 'abc12345', 'unset', 'effort']);
  assert.equal(run.backend.tasks[0]?.effort, null);
  assert.deepEqual(writes(run), ['effort abc12345: xhigh', 'effort abc12345: default']);
  await assert.rejects(run.go(['task', 'abc12345', 'set', 'effort', 'huge']), /low, medium, high, xhigh, max/);
  await assert.rejects(run.go(['task', 'abc12345', 'set', 'effort']), UsageError);
});

test('set icon and unset icon change the icon at once, in any status, and only one emoji is taken', async (context) => {
  const run = runner(context, [task({ id: 'abc12345', status: 'running' })]);
  await run.go(['task', 'abc12345', 'set', 'icon', '🚀']);
  assert.equal(said(run), 'abc12345 has the icon 🚀 now');
  assert.equal(run.backend.tasks[0]?.icon, '🚀');
  run.printed.length = 0;
  await run.go(['task', 'abc12345', 'set', 'icon', '🚀']);
  assert.equal(said(run), 'abc12345 already has the icon 🚀');
  await run.go(['task', 'abc12345']);
  assert.match(said(run), /icon {8}🚀/);
  await run.go(['task', 'abc12345', 'unset', 'icon']);
  assert.equal(run.backend.tasks[0]?.icon, null);
  assert.deepEqual(writes(run), ['icon abc12345: 🚀', 'icon abc12345: none']);
  for (const bad of ['rocket', '🚀🚀', ':rocket:'])
    await assert.rejects(run.go(['task', 'abc12345', 'set', 'icon', bad]), /an icon is one emoji/, bad);
  await assert.rejects(run.go(['task', 'abc12345', 'set', 'icon']), UsageError);
  await assert.rejects(run.go(['task', 'abc12345', 'unset', 'icon', '🚀']), UsageError);
  assert.equal(writes(run).length, 2);
});

test('set labels replaces the labels at once, in any status, and unset labels removes them', async (context) => {
  const run = runner(context, [task({ id: 'abc12345', status: 'running' })]);
  await run.go(['task', 'abc12345', 'set', 'labels', 'bug', 'needs review', 'Bug']);
  assert.equal(said(run), 'abc12345 has the labels bug, needs review now');
  assert.deepEqual(run.backend.tasks[0]?.labels, ['bug', 'needs review']);
  run.printed.length = 0;
  await run.go(['task', 'abc12345', 'set', 'labels', 'bug', 'needs review']);
  assert.equal(said(run), 'abc12345 already has the labels bug, needs review');
  await run.go(['task', 'abc12345']);
  assert.match(said(run), /labels {6}bug, needs review/);
  await run.go(['task', 'abc12345', 'unset', 'labels']);
  assert.deepEqual(run.backend.tasks[0]?.labels, []);
  assert.deepEqual(writes(run), ['labels abc12345: bug,needs review', 'labels abc12345: none']);
  await assert.rejects(run.go(['task', 'abc12345', 'set', 'labels', 'a,b']), /not a label/);
  await assert.rejects(run.go(['task', 'abc12345', 'set', 'labels']), /takes one or more labels/);
  await assert.rejects(run.go(['task', 'abc12345', 'unset', 'labels', 'bug']), UsageError);
  assert.equal(writes(run).length, 2);
});

test('set auto-done on and off, unset auto-done: from the next look on, in any status, with a note on a schedule’s card', async (context) => {
  const run = runner(context, [task({ id: 'abc12345', status: 'running', scheduleId: 'sched001' })]);
  await run.go(['task', 'abc12345', 'set', 'auto-done', 'on']);
  assert.equal(run.backend.tasks[0]?.autoDone, true);
  assert.match(said(run), /abc12345: its agent may move it to Done when it judges every acceptance criterion met/);
  assert.match(
    said(run),
    /next occurrence takes priority, model, effort, lane, auto-done, icon, labels, machine and directory/,
  );
  await run.go(['task', 'abc12345']);
  assert.match(said(run), /auto-done {3}on: the agent may move it to Done/);
  run.printed.length = 0;
  await run.go(['task', 'abc12345', 'set', 'auto-done', 'on']);
  assert.match(said(run), /abc12345 auto-done is already on/);
  await run.go(['task', 'abc12345', 'unset', 'auto-done']);
  assert.equal(run.backend.tasks[0]?.autoDone, false);
  await run.go(['task', 'abc12345', 'set', 'auto-done', 'off']);
  assert.match(said(run), /abc12345 auto-done is already off/);
  assert.deepEqual(writes(run), ['auto-done abc12345: on', 'auto-done abc12345: off']);
  await assert.rejects(run.go(['task', 'abc12345', 'set', 'auto-done', 'maybe']), /auto-done is on or off/);
  await assert.rejects(run.go(['task', 'abc12345', 'set', 'auto-done']), /takes one value/);
  await assert.rejects(run.go(['task', 'abc12345', 'set', 'auto-done', 'on', 'off']), UsageError);
});

test('set dir pins the task to this machine and the directory, drops the session and says so', async (context) => {
  const run = runner(context, [
    task({ id: 'abc12345', machine: 'laptop', workdir: '/old', sessionId: 's1', next: 'resume', paused: true }),
  ]);
  const target = run.make('app');
  await run.go(['task', 'abc12345', 'set', 'dir', 'app']);
  assert.deepEqual(run.backend.tasks[0], {
    ...run.backend.tasks[0],
    machine: 'here',
    workdir: target,
    sessionId: null,
    next: 'fresh',
    paused: false,
    status: 'todo',
  });
  assert.match(said(run), /note: its Claude session is dropped/);
  assert.match(said(run), new RegExp(`abc12345 now runs only on here, in ${target}`));
  assert.deepEqual(writes(run), [`place abc12345: ${target}`]);
});

test('board task says a card waits for a free slot of its schedule', async (context) => {
  const run = runner(context, [task({ id: 'abc12345', scheduleId: 'sch1', held: true })]);
  await run.go(['task', 'abc12345']);
  assert.match(said(run), /schedule {4}sch1 \(at its limit: waits for a free slot\)/);
});

test('a card of a schedule gets a note that the change is for it only, on priority, model and directory', async (context) => {
  const run = runner(context, [task({ id: 'abc12345', scheduleId: 'sched001' }), task({ id: 'def12345' })]);
  run.make('app');
  await run.go(['task', 'abc12345', 'set', 'priority', 'high']);
  await run.go(['task', 'abc12345', 'set', 'model', 'opus']);
  await run.go(['task', 'abc12345', 'set', 'dir', 'app']);
  assert.equal(
    run.printed.filter((line) => /belongs to a schedule; the change applies to it only/.test(line)).length,
    3,
  );
  assert.match(
    said(run),
    /next occurrence takes priority, model, effort, lane, auto-done, icon, labels, machine and directory from the schedule again/,
  );
  const plain = runner(context, [task({ id: 'def12345' })]);
  await plain.go(['task', 'def12345', 'set', 'priority', 'high']);
  assert.doesNotMatch(said(plain), /schedule/);
});

test('set dir needs a config.json, as board schedule does; viewing, priority and model do not', async () => {
  const optional: Record<string, boolean | undefined> = {};
  const go = async (name: string, argv: string[]): Promise<void> => {
    const backend = fakeBackend([task({ id: 'abc12345' })]);
    await runBoard(argv, {
      env: {},
      cwd: tmpdir(),
      writeOut: () => {},
      writeErr: () => {},
      context: (dryRun, options) => {
        optional[name] = options.optionalConfig;
        return { config: CONFIG, backend, dryRun, taskLink: linkTo, print: () => {} };
      },
    }).catch(() => {});
  };
  await go('view', ['task', 'abc12345']);
  await go('priority', ['task', 'abc12345', 'set', 'priority', 'high']);
  await go('model', ['task', 'abc12345', 'set', 'model', 'opus']);
  await go('set dir', ['task', 'abc12345', 'set', 'dir', tmpdir()]);
  await go('unset dir', ['task', 'abc12345', 'unset', 'dir']);
  assert.deepEqual(optional, {
    view: true,
    priority: true,
    model: true,
    'set dir': false,
    'unset dir': true,
  });
});

test('set dir without a path uses the current directory, and ~ expands against the home directory', async (context) => {
  const run = runner(context, [task({ id: 'abc12345' })]);
  await run.go(['task', 'abc12345', 'set', 'dir']);
  assert.equal(run.backend.tasks[0]?.workdir, run.root);
  assert.ok(!said(run).includes('session is dropped'), 'no session, no note');
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'board-task-home-')));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, 'x'));
  const previous = process.env['HOME'];
  process.env['HOME'] = home;
  context.after(() => {
    if (previous === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previous;
  });
  await run.go(['task', 'abc12345', 'set', 'dir', '~/x']);
  assert.equal(run.backend.tasks[0]?.workdir, join(home, 'x'));
});

test('set dir on a task already there prints "already" and writes nothing; a missing path is refused before the board is asked', async (context) => {
  const run = runner(context, [task({ id: 'abc12345', machine: 'here' })]);
  run.backend.tasks[0]!.workdir = run.root;
  await run.go(['task', 'abc12345', 'set', 'dir']);
  assert.match(said(run), /already runs only on here, in /);
  assert.deepEqual(writes(run), []);
  await assert.rejects(run.go(['task', 'abc12345', 'set', 'dir', 'nowhere']), /is not a directory/);
  assert.deepEqual(writes(run), []);
});

test('with a dirs list, a directory that is not listed is refused and points to board dirs add', async (context) => {
  const run = runner(context, [task({ id: 'abc12345' })], { dirs: [{ path: '/srv/listed' }] });
  await assert.rejects(
    run.go(['task', 'abc12345', 'set', 'dir']),
    /is not a listed directory on here.*board dirs add/s,
  );
  assert.deepEqual(writes(run), []);
  run.config.dirs = [{ path: run.root }];
  run.make('sub');
  await run.go(['task', 'abc12345', 'set', 'dir', 'sub']);
  assert.equal(run.backend.tasks[0]?.workdir, join(run.root, 'sub'));
});

test('unset dir removes the directory and the pin, replaces an unreadable one, and says "already" for a task without', async (context) => {
  const run = runner(context, [
    task({ id: 'abc12345', machine: 'laptop', workdir: '/old', sessionId: 's1', next: 'resume' }),
    task({ id: 'def12345' }),
    task({ id: 'ghi12345', unreadable: ['workdir'] }),
  ]);
  await run.go(['task', 'abc12345', 'unset', 'dir']);
  assert.deepEqual(
    [run.backend.tasks[0]?.machine, run.backend.tasks[0]?.workdir, run.backend.tasks[0]?.sessionId],
    [null, null, null],
  );
  assert.match(said(run), /session is dropped/);
  run.printed.length = 0;
  await run.go(['task', 'def12345', 'unset', 'dir']);
  assert.equal(said(run), 'def12345 already has no directory of its own');
  run.printed.length = 0;
  await run.go(['task', 'ghi12345', 'unset', 'dir']);
  assert.match(said(run), /ghi12345 has no directory of its own now/);
  await run.go(['task', 'ghi12345', 'set', 'dir']);
  assert.equal(run.backend.tasks[2]?.workdir, run.root);
});

test('a running or waiting task is refused for a directory change, before anything is written', async (context) => {
  for (const status of ['running', 'waiting'] as const) {
    const run = runner(context, [task({ id: 'abc12345', status, machine: 'here', workdir: '/old' })]);
    await assert.rejects(
      run.go(['task', 'abc12345', 'set', 'dir']),
      new RegExp(`abc12345 is ${status}: stop it first`),
    );
    await assert.rejects(run.go(['task', 'abc12345', 'unset', 'dir']), /stop it first/);
    assert.deepEqual(writes(run), []);
    assert.equal(run.backend.tasks[0]?.workdir, '/old');
  }
});

test('the fake server refuses what the CLI would not have sent (the board’s own 409)', async (context) => {
  const run = runner(context, [task({ id: 'abc12345', status: 'waiting' })]);
  await assert.rejects(
    run.backend.configureTask('abc12345', { place: null }),
    (error: unknown) => error instanceof BackendError && error.status === 409,
  );
});

test('set and unset are refused inside a board run; viewing works there', async (context) => {
  const run = runner(context, [task({ id: 'abc12345' })]);
  const env = { AGENT_BOARD_TASK: 'abc12345' };
  for (const argv of [
    ['set', 'priority', 'high'],
    ['set', 'model', 'opus'],
    ['set', 'effort', 'high'],
    ['set', 'auto-done', 'on'],
    ['unset', 'auto-done'],
    ['set', 'dir'],
    ['unset', 'dir'],
  ])
    await assert.rejects(run.go(['task', 'abc12345', ...argv], { env }), /not available inside a board run/);
  assert.deepEqual(writes(run), []);
  await run.go(['task', 'abc12345'], { env });
  assert.match(said(run), /abc12345 {2}task abc12345/);
});

test('--dry-run is accepted before and after the action, and the command confirms nothing in it', async (context) => {
  const run = runner(context, [task({ id: 'abc12345', sessionId: 's1' })]);
  await run.go(['--dry-run', 'task', 'abc12345', 'set', 'priority', 'low']);
  await run.go(['task', 'abc12345', 'set', 'dir', '--dry-run']);
  assert.ok(!said(run).includes('priority is now'));
});

test('a server without the feature makes the command refuse with the standard text', async (context) => {
  const run = runner(context, [task({ id: 'abc12345' })]);
  run.backend.configureTask = async () => {
    throw new BackendError('the board server does not support changing a task’s settings yet; update the board server');
  };
  await assert.rejects(
    run.go(['task', 'abc12345', 'set', 'priority', 'high']),
    /does not support changing a task’s settings/,
  );
});

test('unknown actions and keys are usage errors', async (context) => {
  const run = runner(context, [task({ id: 'abc12345' })]);
  await assert.rejects(run.go(['task', 'abc12345', 'frob']), /takes nothing, or set or unset/);
  await assert.rejects(
    run.go(['task', 'abc12345', 'set', 'colour', 'red']),
    /takes priority, model, effort, lane, auto-done, icon, labels, dir or prompt/,
  );
  await assert.rejects(run.go(['task', 'abc12345', 'set', 'dir', 'a', 'b']), /takes one path/);
  await assert.rejects(run.go(['task', 'abc12345', 'unset', 'model', 'x']), UsageError);
});
