import {
  agentBinding,
  deriveKeys,
  inputBinding,
  machineCatalogBinding,
  machineUsageBinding,
  machineFeedsBinding,
  sealMachineFeeds,
  machineDirsBinding,
  prBinding,
  seal,
  sealPr,
  sealWatches,
  watchesBinding,
  transcriptBinding,
  UNREADABLE_TEXT,
} from '@agent-board/shared';
import type { PrState, TaskWatch } from '@agent-board/shared';
import { describe, expect, it } from 'vitest';
import {
  openBoardTask,
  openCatalogs,
  openContext,
  openEvent,
  openFeeds,
  openListedTasks,
  openMachines,
} from './opening';
import { sealerFor } from './contexts';
import type { RouterOutputs } from './wire';

const keys = await deriveKeys(
  Uint8Array.from({ length: 32 }, (_, i) => i),
  'alice',
  { index: true },
);
const PR_URL = 'https://github.com/acme/app/pull/17';
const OTHER_PR_URL = 'https://github.com/acme/app/pull/18';

const wireTask = async (
  prs: { id: string; pr: string; state: PrState | null }[],
  promptPrState: PrState | null = null,
): Promise<RouterOutputs['tasks']['get']['task']> => {
  const sealer = sealerFor(keys);
  return {
    id: 'task0001',
    title: await sealer({ field: 'title', context: 'task:task0001' }, 'A task'),
    input: await sealer({ field: 'input', context: 'task:task0001:user' }, 'Fix the bug'),
    workdir: null,
    prs,
    promptPrState,
    status: 'needs-me',
    priority: 'normal',
    createdBy: 'user',
    closed: false,
    openQuestion: false,
    machine: null,
    lane: null,
    requestedLane: null,
    sessionId: null,
    next: 'fresh',
    head: null,
    scheduleId: null,
    wakeAt: null,
    waitCheck: false,
    woken: false,
    parentId: null,
    proposed: false,
    paused: false,
    notBefore: null,
    lastActiveAt: null,
    runStartedAt: null,
    borrowed: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as RouterOutputs['tasks']['get']['task'];
};

describe('the PRs of a task, as the browser opens it', () => {
  const sealedPr = (url: string) => sealPr(sealerFor(keys), 'task0001', url);

  it('are the PRs the agent of the task sealed, in order, each with its state', async () => {
    const task = await openBoardTask(
      keys,
      await wireTask([
        { id: 'a', pr: await sealedPr(PR_URL), state: 'merged' },
        { id: 'b', pr: await sealedPr(OTHER_PR_URL), state: null },
      ]),
    );
    expect(task.prs).toEqual([
      { id: 'a', url: PR_URL, state: 'merged' },
      { id: 'b', url: OTHER_PR_URL, state: null },
    ]);
  });

  it('are none when the board has none', async () => {
    expect((await openBoardTask(keys, await wireTask([]))).prs).toEqual([]);
  });

  it('leave out one sealed for another task, another purpose, or not a PR URL, or not sealed', async () => {
    const sealer = sealerFor(keys);
    for (const value of [
      await sealPr(sealer, 'other001', PR_URL),
      await seal(keys, 'pr', 'task:task0001:user', PR_URL),
      await seal(keys, 'input', 'task:task0001:user', PR_URL),
      await seal(keys, 'pr', prBinding('task0001').context, 'https://example.com/x'),
      await seal(keys, 'pr', prBinding('task0001').context, 'javascript:alert(1)'),
      PR_URL,
    ])
      expect((await openBoardTask(keys, await wireTask([{ id: 'a', pr: value, state: null }]))).prs).toEqual([]);
  });

  it('keep the good ones next to a refused one', async () => {
    const task = await openBoardTask(
      keys,
      await wireTask([
        { id: 'a', pr: PR_URL, state: null },
        { id: 'b', pr: await sealedPr(OTHER_PR_URL), state: 'open' },
      ]),
    );
    expect(task.prs).toEqual([{ id: 'b', url: OTHER_PR_URL, state: 'open' }]);
  });

  it('come with the state of the prompt’s PR', async () => {
    const task = await openBoardTask(keys, await wireTask([], 'closed'));
    expect(task.promptPrState).toBe('closed');
  });
});

describe('the watches of a task, as the browser opens it', () => {
  const watch: TaskWatch = {
    id: '0123456789abcdef',
    name: 'ci',
    kind: 'ci',
    label: 'CI #116',
    status: '4 of 7 passed',
    deadline: '2026-11-17T14:20:00.000Z',
  };
  const open = async (watches: string | null | undefined, watchStops?: string[]) =>
    openBoardTask(keys, { ...(await wireTask([])), watches, watchStops } as RouterOutputs['tasks']['get']['task']);

  it('are the list the agent of the task sealed, with the stops waiting for the machine', async () => {
    const task = await open(await sealWatches(sealerFor(keys), 'task0001', [watch], 3), ['fedcba9876543210']);
    expect(task.watches).toEqual([watch]);
    expect(task.watchEvents).toBe(3);
    expect(task.watchStops).toEqual(['fedcba9876543210']);
    expect(task.unreadable).toEqual([]);
  });

  it('are none, and no stops, when the board sent neither key', async () => {
    const task = await open(undefined);
    expect(task.watches).toBeNull();
    expect(task.watchEvents).toBe(0);
    expect(task.watchStops).toEqual([]);
    expect(task.unreadable).toEqual([]);
  });

  it('keeps only well-formed stop ids, and none when the board sent no list', async () => {
    const task = await open(null, ['fedcba9876543210', 'junk', 7, '0123456789ABCDEF'] as unknown as string[]);
    expect(task.watchStops).toEqual(['fedcba9876543210']);
    expect((await open(null, 'fedcba9876543210' as unknown as string[])).watchStops).toEqual([]);
  });

  it('are none and unreadable when sealed for another task, not sealed, or not a list', async () => {
    for (const value of [
      await sealWatches(sealerFor(keys), 'other001', [watch], 0),
      JSON.stringify({ watches: [watch] }),
      await seal(keys, 'watches', watchesBinding('task0001').context, 'not json'),
    ]) {
      const task = await open(value);
      expect(task.watches).toBeNull();
      expect(task.unreadable).toContain('watches');
    }
  });
});

describe('the agent of a task, as the browser opens it', () => {
  const row = { kind: 'task', id: 'task0001', createdBy: 'user', scheduleId: null, forkOf: null } as const;
  const sealedFor = async (agent: string | null) => {
    const sealer = sealerFor(keys);
    const wire = await wireTask([]);
    return {
      ...wire,
      input: await sealer(inputBinding({ ...row, agent }), 'Fix the bug'),
      ...(agent === null ? {} : { agent: await sealer(agentBinding(row), agent) }),
    };
  };

  it('is the name the task was sealed with, and the prompt opens under it', async () => {
    const task = await openBoardTask(keys, await sealedFor('reviewer'));
    expect([task.agent, task.input, task.unreadable]).toEqual(['reviewer', 'Fix the bug', []]);
  });

  it('is none for a task without one', async () => {
    const task = await openBoardTask(keys, await sealedFor(null));
    expect([task.agent, task.unreadable]).toEqual([null, []]);
  });

  it('makes the task unreadable when the board dropped it, so the page never shows a prompt that would run unrestricted', async () => {
    const { agent: _dropped, ...stripped } = await sealedFor('reviewer');
    const task = await openBoardTask(keys, stripped);
    expect([task.agent, task.input, task.unreadable]).toEqual([null, '', ['input']]);
  });

  it('is unreadable when it was sealed for another task or is not a name', async () => {
    const sealer = sealerFor(keys);
    const elsewhere = await sealer(agentBinding({ ...row, id: 'other001' }), 'reviewer');
    expect((await openBoardTask(keys, { ...(await sealedFor('reviewer')), agent: elsewhere })).unreadable).toContain(
      'agent',
    );
    const notAName = await sealer(agentBinding(row), '../etc');
    expect((await openBoardTask(keys, { ...(await sealedFor('reviewer')), agent: notAName })).agent).toBeNull();
  });
});

describe('the directory lists of machines, as the browser opens them', () => {
  const sealFor = (machine: string, text: string) => sealerFor(keys)(machineDirsBinding(machine), text);
  const list = (paths: string[]) => JSON.stringify({ dirs: paths.map((path) => ({ path })) });
  const wire = (name: string, dirs: string | null, revokedAt: Date | null = null) =>
    ({ name, dirs, revokedAt, lastSeenAt: null }) as unknown as RouterOutputs['machines']['list'][number];
  const openOne = async (...machines: RouterOutputs['machines']['list']) => (await openMachines(keys, machines))[0];

  it('opens a good list under the machine own name', async () => {
    const machine = await openOne(wire('laptop', await sealFor('laptop', list(['/a', '/b c']))));
    expect(machine).toMatchObject({ shown: 'laptop', dirs: [{ path: '/a' }, { path: '/b c' }], dirsUnreadable: false });
  });

  it('carries a label with its directory and drops one that is not a safe label, keeping the list', async () => {
    const text = JSON.stringify({
      dirs: [
        { path: '/a', label: 'Board', repo: 'o/n' },
        { path: '/b', label: ' padded ' },
        { path: '/c', label: 7 },
        { path: '/d' },
      ],
    });
    const machine = await openOne(wire('laptop', await sealFor('laptop', text)));
    expect(machine).toMatchObject({
      dirs: [{ path: '/a', label: 'Board' }, { path: '/b' }, { path: '/c' }, { path: '/d' }],
      dirsUnreadable: false,
    });
  });

  it('has no list when the machine sent none', async () => {
    expect(await openOne(wire('laptop', null))).toMatchObject({ dirs: null, dirsUnreadable: false });
  });

  it('is unreadable when it was sealed for another machine name', async () => {
    const machine = await openOne(wire('laptop', await sealFor('desktop', list(['/a']))));
    expect(machine).toMatchObject({ dirs: null, dirsUnreadable: true });
  });

  it.each([
    ['not JSON', 'nope'],
    ['not an object with dirs', JSON.stringify(['/a'])],
    ['an entry without a path', JSON.stringify({ dirs: [{}] })],
    ['a relative path', list(['relative'])],
    ['a path with a control character', list(['/a\nb'])],
  ])('is unreadable when the list is %s', async (_, text) => {
    expect(await openOne(wire('laptop', await sealFor('laptop', text)))).toMatchObject({
      dirs: null,
      dirsUnreadable: true,
    });
  });

  it('is unreadable when it is not an envelope', async () => {
    expect(await openOne(wire('laptop', list(['/a'])))).toMatchObject({ dirs: null, dirsUnreadable: true });
  });

  it('offers nothing for a revoked machine', async () => {
    const sealed = await sealFor('laptop', list(['/a']));
    expect(await openOne(wire('laptop', sealed, new Date()))).toMatchObject({ dirs: null, dirsUnreadable: false });
  });

  it('offers nothing for a machine whose name does not pass the shape check', async () => {
    const name = 'bad name\n';
    const machine = await openOne(wire(name, await sealFor(name, list(['/a']))));
    expect(machine).toMatchObject({ shown: '(invalid)', name, dirs: null, dirsUnreadable: false });
  });
});

describe('the usage status of machines, as the browser opens them', () => {
  const usage = {
    limits: { fiveHour: 80, priority: 'urgent' },
    windows: { fiveHour: { percent: 85, resetsAt: '2026-11-17T14:05:00.000Z', seenAt: '2026-11-17T12:00:00.000Z' } },
    reached: ['fiveHour'],
    held: ['taskA'],
    open: [],
  };
  const sealFor = (machine: string, text: string) => sealerFor(keys)(machineUsageBinding(machine), text);
  const wire = (name: string, sealed: string | null, revokedAt: Date | null = null) =>
    ({ name, usage: sealed, revokedAt, lastSeenAt: null }) as unknown as RouterOutputs['machines']['list'][number];
  const openOne = async (...machines: RouterOutputs['machines']['list']) => (await openMachines(keys, machines))[0];

  it('opens a good status under the machine own name', async () => {
    const machine = await openOne(wire('laptop', await sealFor('laptop', JSON.stringify(usage))));
    expect(machine).toMatchObject({ usage, usageUnreadable: false });
  });

  it('has no status when the machine sent none', async () => {
    expect(await openOne(wire('laptop', null))).toMatchObject({ usage: null, usageUnreadable: false });
  });

  it('drops an id that is no task id and keeps the rest', async () => {
    const text = JSON.stringify({ ...usage, held: ['taskA', '../x'] });
    expect((await openOne(wire('laptop', await sealFor('laptop', text))))?.usage?.held).toEqual(['taskA']);
  });

  it('is unreadable when sealed for another machine, not JSON or not a status', async () => {
    expect(await openOne(wire('laptop', await sealFor('desktop', JSON.stringify(usage))))).toMatchObject({
      usage: null,
      usageUnreadable: true,
    });
    for (const text of ['nope', '[]', '{"held":"x"}'])
      expect(await openOne(wire('laptop', await sealFor('laptop', text)))).toMatchObject({
        usage: null,
        usageUnreadable: true,
      });
    expect(await openOne(wire('laptop', JSON.stringify(usage)))).toMatchObject({ usageUnreadable: true });
  });

  it('offers nothing for a revoked machine or a name that does not pass the shape check', async () => {
    const sealed = await sealFor('laptop', JSON.stringify(usage));
    expect(await openOne(wire('laptop', sealed, new Date()))).toMatchObject({ usage: null, usageUnreadable: false });
    const name = 'bad name\n';
    expect(await openOne(wire(name, await sealFor(name, JSON.stringify(usage))))).toMatchObject({
      usage: null,
      usageUnreadable: false,
    });
  });
});

describe('the catalogues of machines, as the browser opens them', () => {
  const catalog = {
    claude: '2.1.326',
    models: [{ value: 'opus', label: 'Opus' }],
    skills: [{ name: 'review', description: 'Reviews', argumentHint: '<pr>' }],
    dirs: { '/a': [{ name: 'deploy' }] },
  };
  const sealFor = (machine: string, text: string) => sealerFor(keys)(machineCatalogBinding(machine), text);
  const wire = (name: string, sealed: string | null) =>
    ({ name, catalog: sealed, catalogUpdatedAt: null }) as RouterOutputs['machines']['catalogs'][number];
  const openOne = async (...catalogs: RouterOutputs['machines']['catalogs']) => (await openCatalogs(keys, catalogs))[0];

  it('opens a good catalogue under the machine own name', async () => {
    const opened = await openOne(wire('laptop', await sealFor('laptop', JSON.stringify(catalog))));
    expect(opened).toEqual({ name: 'laptop', catalog });
  });

  it('has no catalogue when it was sealed for another machine, is not an envelope or is not of its shape', async () => {
    const elsewhere = await sealFor('desktop', JSON.stringify(catalog));
    expect(await openOne(wire('laptop', elsewhere))).toEqual({ name: 'laptop', catalog: null });
    expect(await openOne(wire('laptop', JSON.stringify(catalog)))).toEqual({ name: 'laptop', catalog: null });
    const shapeless = await sealFor('laptop', JSON.stringify({ models: 'x' }));
    expect(await openOne(wire('laptop', shapeless))).toEqual({ name: 'laptop', catalog: null });
  });

  it('offers nothing for a name that does not pass the shape check', async () => {
    const name = 'bad name\n';
    expect(await openOne(wire(name, await sealFor(name, JSON.stringify(catalog))))).toEqual({ name, catalog: null });
  });
});

describe('the events of a run, as the browser opens them', () => {
  const run = { taskId: 'task0001', runId: 'run00001' };
  const AT = '2026-11-16T12:00:00.000Z';
  const wireEvent = async (data: Record<string, unknown>, outputSize: number | null = null) => ({
    seq: 3,
    at: AT,
    kind: String(data['kind']),
    parent: null,
    data: await sealerFor(keys)(transcriptBinding('tr.data', run.taskId, run.runId, 3), JSON.stringify(data)),
    outputSize,
  });
  const base = { seq: 3, at: AT, parent: null };

  it('fills what an older worker did not write: a result without denials or cost', async () => {
    const event = await openEvent(
      keys,
      run,
      await wireEvent({ ...base, kind: 'result', text: 'done', isError: false }),
    );
    expect(event).toEqual({
      ...base,
      kind: 'result',
      text: 'done',
      isError: false,
      turns: null,
      durationMs: null,
      costUsd: null,
      denials: [],
      outputSize: null,
    });
  });

  it('shows an event that does not fit its kind as unreadable instead of passing it on', async () => {
    const event = await openEvent(keys, run, await wireEvent({ ...base, kind: 'result', denials: 'none' }));
    expect(event).toMatchObject({ seq: 3, kind: 'note', text: UNREADABLE_TEXT });
  });

  it('lists a tool result with its output size and without an output', async () => {
    const data = { ...base, kind: 'tool_result', toolUseId: 'toolu_1', isError: false };
    const event = await openEvent(keys, run, await wireEvent(data, 12));
    expect(event).toEqual({ ...data, outputSize: 12 });
  });
});

describe('the context reading of a task, as the browser opens it', () => {
  const taskId = 'task0001';
  const runId = 'run00001';
  const AT = '2026-11-16T12:00:00.000Z';
  const reading = {
    seq: 7,
    at: AT,
    parent: null,
    kind: 'context',
    used: 133_600,
    window: 1_000_000,
    threshold: 80,
    model: 'opus',
  };
  const wire = async (sealedSeq: number, data: unknown = reading) => ({
    runId,
    seq: 7,
    at: AT,
    data: await sealerFor(keys)(transcriptBinding('tr.data', taskId, runId, sealedSeq), JSON.stringify(data)),
  });

  it('has no reading when the run reported none', async () => {
    expect(await openContext(keys, taskId, null)).toBeNull();
  });

  it('opens a sealed reading', async () => {
    expect(await openContext(keys, taskId, await wire(7))).toEqual({
      used: 133_600,
      window: 1_000_000,
      threshold: 80,
      model: 'opus',
      at: AT,
    });
  });

  it('shows a value sealed under another position, or of another shape, as unreadable', async () => {
    expect(await openContext(keys, taskId, await wire(8))).toBe('unreadable');
    expect(await openContext(keys, taskId, await wire(7, { ...reading, used: 'lots' }))).toBe('unreadable');
  });

  it('shows a value whose own position differs from the one it was served under as unreadable', async () => {
    expect(await openContext(keys, taskId, await wire(7, { ...reading, seq: 9 }))).toBe('unreadable');
  });

  it('opens the readings of a listing, and gives a card nothing for an unreadable one', async () => {
    const task = await wireTask([]);
    const [readable, unreadable, none] = await openListedTasks(keys, [
      { ...task, lastNote: null, context: await wire(7) },
      { ...task, lastNote: null, context: await wire(8) },
      { ...task, lastNote: null, context: null },
    ]);
    expect(readable?.context).toMatchObject({ used: 133_600, window: 1_000_000 });
    expect(unreadable?.context).toBeNull();
    expect(none?.context).toBeNull();
  });

  it('refuses a run id that is not an id without throwing', async () => {
    expect(await openContext(keys, taskId, { ...(await wire(7)), runId: 'bad id\n' })).toBe('unreadable');
  });
});

describe('the feeds of a machine, as the browser opens them', () => {
  const feed = {
    id: '0123456789abcdef',
    name: 'reviews',
    everyMs: 600_000,
    paused: false,
    runAsked: false,
    history: [],
  };
  const row = async (name: string, overrides: Partial<RouterOutputs['feeds']['list'][number]> = {}) => ({
    name,
    feeds: await sealMachineFeeds(sealerFor(keys), name, { feeds: [feed] }),
    feedsUpdatedAt: '2026-11-23T12:00:00.000Z',
    feedRequests: [],
    lastSeenAt: '2026-11-23T12:01:00.000Z',
    ...overrides,
  });

  it('opens the feeds and keeps the pending requests that name a known action and a feed id', async () => {
    const requests = ['pause:0123456789abcdef', 'run:short', 'delete:0123456789abcdef', 'run:0123456789abcdef:x'];
    const [opened] = await openFeeds(keys, [await row('laptop', { feedRequests: requests })]);
    expect(opened?.feeds).toEqual([feed]);
    expect(opened?.requests).toEqual(['pause:0123456789abcdef']);
    expect(opened?.lastSeenAt).toBe('2026-11-23T12:01:00.000Z');
  });

  it('gives no feeds for a document sealed for another machine, and for one that is not a feeds document', async () => {
    const other = await sealerFor(keys)(machineFeedsBinding('desktop'), JSON.stringify({ feeds: [feed] }));
    const notFeeds = await sealerFor(keys)(machineFeedsBinding('laptop'), JSON.stringify({ nothing: true }));
    const opened = await openFeeds(keys, [
      await row('laptop', { feeds: other }),
      await row('tablet', { feeds: notFeeds }),
      await row('phone', { feeds: 'abe1.notanenvelope' }),
    ]);
    expect(opened.map((entry) => entry.feeds)).toEqual([null, null, null]);
  });
});
