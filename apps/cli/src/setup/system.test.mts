import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSystem, parseUnitState, parseUnixTimestamp, parseWorkerUnits, SystemError } from './system.mts';

test('only known unit states answer; anything else throws', () => {
  for (const state of ['active\n', 'activating', 'deactivating']) assert.equal(parseUnitState(state), true);
  for (const state of ['inactive\n', 'failed']) assert.equal(parseUnitState(state), false);
  for (const state of ['', 'Failed to connect to bus: No medium found', 'unknown']) {
    assert.throws(() => parseUnitState(state), SystemError);
  }
});

test('only units running `internal worker <id>` for their own id are workers', () => {
  const out = [
    'agent-board-abc12345.service loaded active running /home/u/.local/bin/board internal worker abc12345',
    '● agent-board-Xy_9-z.service loaded activating start /usr/bin/node /opt/board/apps/cli/src/main.mts internal worker Xy_9-z',
    'agent-board-dispatch.service loaded active running agent-board dispatcher: one tick',
    'agent-board-intake.service loaded active running agent-board intake: review requests to tasks',
    'agent-board-listen.service loaded active running agent-board listener: dispatch as soon as the board says tasks changed',
    "agent-board-watch.service loaded active running agent-board watch unit: runs the watches of this machine's tasks",
    'agent-board-watch.service loaded active running /home/u/.local/bin/board internal watch',
    'agent-board-watch.service loaded active running /home/u/.local/bin/board internal worker watch',
    'agent-board-foo.service loaded active running a unit the user made',
    'agent-board-server.service loaded active running /usr/bin/node server.js',
    'agent-board-other1.service loaded active running /home/u/.local/bin/board internal worker abc12345',
    'agent-board-listen.service loaded active running /home/u/.local/bin/board internal worker listen',
    'other.service loaded active running /home/u/.local/bin/board internal worker other',
  ].join('\n');
  assert.deepEqual(parseWorkerUnits(out), ['abc12345', 'Xy_9-z']);
  assert.deepEqual(parseWorkerUnits(''), []);
});

test('the unit start time is read from a unix timestamp', () => {
  assert.equal(parseUnixTimestamp('@1794468224\n')?.toISOString(), '2026-11-12T07:23:44.000Z');
  assert.equal(parseUnixTimestamp(''), undefined);
  assert.equal(parseUnixTimestamp('@0'), undefined);
});

test('a worker unit is started only for a task id of the safe shape, so no argument or unit name can be injected', async () => {
  const lines: string[] = [];
  const system = createSystem({ dryRun: true, print: (line) => void lines.push(line) });
  for (const hostile of [
    '--property=ExecStart=/bin/sh',
    '../x',
    'a b',
    'dispatch',
    'intake',
    'listen',
    'watch',
    '',
    'x'.repeat(65),
  ])
    await assert.rejects(system.startWorker(hostile), SystemError, hostile);
  assert.deepEqual(lines, []);
  await system.startWorker('Ab3dEf9x');
  assert.match(lines[0] ?? '', /--unit=agent-board-Ab3dEf9x .* -- \S+ \S+\/src\/main\.mts internal worker Ab3dEf9x$/);
});

interface Call {
  file: string;
  args: string[];
}

// A runner that records each call and answers from `answer`; a thrown value is the rejection, as execFile rejects.
function recorder(answer: (call: Call) => string | Error = () => '') {
  const calls: Call[] = [];
  const run = async (file: string, args: string[]): Promise<{ stdout: string }> => {
    const call = { file, args };
    calls.push(call);
    const result = answer(call);
    if (result instanceof Error) throw result;
    return { stdout: result };
  };
  return { calls, run };
}

const failed = (message: string, stdout?: string): Error => Object.assign(new Error(message), { stdout, stderr: '' });

test('the unit queries run systemctl --user with the arguments they need', async () => {
  const { calls, run } = recorder(({ args }) => {
    if (args.includes('is-active')) return 'active\n';
    if (args.includes('show')) return '@1794468224\n';
    return 'agent-board-Ab3dEf9x.service loaded active running /bin/board internal worker Ab3dEf9x\n';
  });
  const system = createSystem({ dryRun: false, print: () => undefined, run });
  assert.equal(await system.isActive('agent-board-listen.service'), true);
  assert.equal((await system.startedAt('agent-board-listen.service'))?.toISOString(), '2026-11-12T07:23:44.000Z');
  assert.deepEqual(await system.activeWorkers(), ['Ab3dEf9x']);
  assert.deepEqual(calls, [
    { file: 'systemctl', args: ['--user', 'is-active', 'agent-board-listen.service'] },
    {
      file: 'systemctl',
      args: [
        '--user',
        '--timestamp=unix',
        'show',
        '--property=ActiveEnterTimestamp',
        '--value',
        'agent-board-listen.service',
      ],
    },
    {
      file: 'systemctl',
      args: [
        '--user',
        'list-units',
        'agent-board-*',
        '--type=service',
        '--state=active,activating,reloading,deactivating',
        '--plain',
        '--full',
        '--no-legend',
        '--no-pager',
      ],
    },
  ]);
});

test('a failed systemctl that still printed a state answers with it; one that printed nothing throws', async () => {
  const inactive = createSystem({
    dryRun: false,
    print: () => undefined,
    run: recorder(() => failed('Command failed: exit 3', 'inactive\n')).run,
  });
  assert.equal(await inactive.isActive('agent-board-x.service'), false);
  const broken = createSystem({
    dryRun: false,
    print: () => undefined,
    run: recorder(() => failed('Command failed: systemctl\nFailed to connect to bus', '')).run,
  });
  await assert.rejects(broken.isActive('agent-board-x.service'), {
    name: 'Error',
    message: 'systemctl --user is-active failed: Command failed: systemctl',
  });
  await assert.rejects(broken.activeWorkers(), SystemError);
  await assert.rejects(broken.startedAt('agent-board-x.service'), SystemError);
});

test('stop runs systemctl stop and shrugs off a failure; a dry run only prints the line', async () => {
  const { calls, run } = recorder(() => failed('not loaded'));
  await createSystem({ dryRun: false, print: () => undefined, run }).stop('agent-board-Ab3dEf9x.service');
  assert.deepEqual(calls, [{ file: 'systemctl', args: ['--user', 'stop', 'agent-board-Ab3dEf9x.service'] }]);
  const lines: string[] = [];
  const dry = recorder();
  await createSystem({ dryRun: true, print: (line) => void lines.push(line), run: dry.run }).stop(
    'agent-board-x.service',
  );
  assert.deepEqual(lines, ['DRY systemctl --user stop agent-board-x.service']);
  assert.deepEqual(dry.calls, []);
});

test('startWorker runs systemd-run with the environment the worker needs, then reads its main PID', async (t) => {
  const saved = { ...process.env };
  t.after(() => {
    for (const name of [
      'AGENT_BOARD_CONFIG_DIR',
      'AGENT_BOARD_STATE_DIR',
      'AGENT_BOARD_RUN_DIR',
      'XDG_STATE_HOME',
      'XDG_RUNTIME_DIR',
    ])
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
  });
  for (const name of ['AGENT_BOARD_CONFIG_DIR', 'AGENT_BOARD_RUN_DIR', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR'])
    delete process.env[name];
  process.env['AGENT_BOARD_STATE_DIR'] = '/tmp/state';
  process.env['AGENT_BOARD_RUN_DIR'] = '';

  const { calls, run } = recorder(({ file }) => (file === 'systemctl' ? '4242\n' : ''));
  const started = await createSystem({ dryRun: false, print: () => undefined, run }).startWorker('Ab3dEf9x');
  assert.deepEqual(started, { pid: 4242 });
  const [systemdRun, show] = calls;
  assert.equal(systemdRun?.file, 'systemd-run');
  const split = systemdRun?.args.indexOf('--') ?? -1;
  assert.deepEqual(systemdRun?.args.slice(0, split), [
    '--user',
    '--quiet',
    '--collect',
    '--unit=agent-board-Ab3dEf9x',
    '--setenv=PATH',
    '--setenv=HOME',
    '--setenv=AGENT_BOARD_STATE_DIR',
  ]);
  assert.deepEqual(systemdRun?.args.slice(-3), ['internal', 'worker', 'Ab3dEf9x']);
  assert.deepEqual(show, {
    file: 'systemctl',
    args: ['--user', 'show', '--property=MainPID', '--value', 'agent-board-Ab3dEf9x'],
  });

  const lines: string[] = [];
  const dry = recorder();
  const dryStarted = await createSystem({
    dryRun: true,
    print: (line) => void lines.push(line),
    run: dry.run,
  }).startWorker('Ab3dEf9x');
  assert.deepEqual(dryStarted, { pid: undefined });
  assert.deepEqual(dry.calls, []);
  assert.deepEqual(lines, [`DRY systemd-run ${systemdRun?.args.join(' ')}`]);
});

test('startWorker gives no PID when systemctl show fails or reports none, and fails when systemd-run does', async () => {
  for (const answer of [failed('show failed'), '0\n', '\n']) {
    const { run } = recorder(({ file }) => (file === 'systemctl' ? answer : ''));
    assert.deepEqual(await createSystem({ dryRun: false, print: () => undefined, run }).startWorker('Ab3dEf9x'), {
      pid: undefined,
    });
  }
  const { calls, run } = recorder(() => failed('Failed to start transient service unit'));
  await assert.rejects(
    createSystem({ dryRun: false, print: () => undefined, run }).startWorker('Ab3dEf9x'),
    /Failed to start transient service unit/,
  );
  assert.equal(calls.length, 1, 'no PID is asked for a unit that did not start');
});

test('signalWorker sends the signal to the unit main process only, and a dry run only prints the line', async () => {
  const { calls, run } = recorder(() => failed('not loaded'));
  await createSystem({ dryRun: false, print: () => undefined, run }).signalWorker('agent-board-Ab3dEf9x', 'SIGUSR2');
  assert.deepEqual(calls, [
    { file: 'systemctl', args: ['--user', 'kill', '--kill-whom=main', '--signal=SIGUSR2', 'agent-board-Ab3dEf9x'] },
  ]);
  const lines: string[] = [];
  const dry = recorder();
  await createSystem({ dryRun: true, print: (line) => void lines.push(line), run: dry.run }).signalWorker(
    'agent-board-x',
    'SIGUSR2',
  );
  assert.deepEqual(lines, ['DRY systemctl --user kill --kill-whom=main --signal=SIGUSR2 agent-board-x']);
  assert.deepEqual(dry.calls, []);
});
