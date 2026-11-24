// @vitest-environment node
import {
  agentBinding,
  deriveKeys,
  exportHeaderLine,
  exportRowLine,
  iconBinding,
  inputBinding,
  labelsBinding,
  linkRulesBinding,
  machineCatalogBinding,
  machineDirsBinding,
  machineUsageBinding,
  noteBinding,
  open,
  seal,
  sealLinkRules,
  sealMachineFeeds,
  sealNote,
  sealPr,
  sealQuestions,
  sealAnswers,
  sealSharedAgents,
  sealTitleRules,
  sealWatches,
  titleBinding,
  titleRulesBinding,
  toBase64Url,
  transcriptBinding,
  workdirBinding,
  type Binding,
  type Keys,
  type RowRef,
  type Sealer,
  type TaskWatch,
} from '@agent-board/shared';
import { writeFileSync } from 'node:fs';
import { describe, it, vi } from 'vitest';
import { PRODUCTION_KDF, derivePassphraseKey } from '@agent-board/shared/ui';
import { argon2idHash, createKeySetup } from '../crypto/unlocker';
import {
  FIXTURES,
  openers,
  redact,
  sealers,
  valueAt,
  type KeyFixture,
  type RequestCase,
  type ResponseCase,
} from './goldenCalls';

const ids = vi.hoisted(() => ({ queue: [] as string[] }));

vi.mock('@agent-board/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-board/shared')>()),
  newTaskId: () => ids.queue.shift() ?? 'unset',
}));

const OWNER = 'alice';
const dataKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const T0 = '2026-11-20T09:00:00.000Z';
const T1 = '2026-11-20T09:30:00.000Z';
const WORKDIR = '/home/alice/app';

const writeJson = (name: string, value: unknown): void =>
  writeFileSync(new URL(name, FIXTURES), `${JSON.stringify(value, null, 2)}\n`);

const sealerFor =
  (keys: Keys): Sealer =>
  (binding, plaintext) =>
    seal(keys, binding.field, binding.context, plaintext);

type TaskRow = Extract<RowRef, { kind: 'task' }>;

const userRow = (id: string, agent: string | null = null, forkOf: string | null = null): TaskRow => ({
  kind: 'task',
  id,
  createdBy: 'user',
  scheduleId: null,
  agent,
  forkOf,
});

describe.skipIf(process.env['GOLDEN_WRITE'] !== '1')('writing the golden fixtures', () => {
  it('writes the keys, the sealed requests and the opened responses', async () => {
    const keys = await deriveKeys(dataKey, OWNER);

    const salt = Uint8Array.from({ length: 16 }, (_, index) => 0xa0 + index);
    const passphrase = 'golden vector passphrase, throwaway';
    const created = await createKeySetup({ owner: OWNER, passphrase: 'golden setup passphrase, throwaway' });
    const keyFixture: KeyFixture = {
      owner: OWNER,
      dataKey: toBase64Url(dataKey),
      keyId: keys.keyId,
      kdf: PRODUCTION_KDF,
      passphrase,
      salt: toBase64Url(salt),
      wrappingKey: toBase64Url(await derivePassphraseKey(passphrase, salt, PRODUCTION_KDF, argon2idHash)),
      setup: {
        passphrase: 'golden setup passphrase, throwaway',
        recoveryKey: created.recoveryKey,
        keyId: created.keys.keyId,
        keySetup: created.setup,
      },
    };
    writeJson('keys.json', keyFixture);

    const sealWith = sealerFor(keys);
    const request = async (
      name: string,
      sealer: string,
      args: unknown[],
      specs: [string, Binding][],
      newIds: string[] = [],
    ): Promise<RequestCase> => {
      ids.queue = [...newIds];
      const sealed: unknown = JSON.parse(JSON.stringify(await sealers[sealer]?.(keys, args)));
      const fields = await Promise.all(
        specs.map(async ([at, binding]) => ({
          at,
          field: binding.field,
          context: binding.context,
          plaintext: await open(keys, binding.field, binding.context, valueAt(sealed, at) as string),
        })),
      );
      return {
        name,
        sealer,
        ids: newIds,
        args,
        sealed,
        fields,
        clear: redact(
          sealed,
          fields.map((field) => field.at),
        ),
      };
    };

    const taskId = 'tsk000000001';
    const scheduleId = 'sch000000001';
    const fullRow = userRow('tsk000000010', 'reviewer');
    const repeatRow: RowRef = { kind: 'schedule', id: 'sch000000010' };
    const plainRow = userRow(taskId, 'reviewer');
    const scheduleRow: RowRef = { kind: 'schedule', id: scheduleId, agent: 'reviewer' };
    const forkRow = userRow('tsk000000011', 'reviewer', taskId);
    const notes = (author: 'user' | 'agent', kind: 'comment' | 'event' | 'answer', id = taskId) => ({
      body: noteBinding('note.body', id, author, kind),
      preview: noteBinding('note.preview', id, author, kind),
    });
    const questions = [
      {
        header: 'Scope',
        question: 'Which redirect should change?',
        multiSelect: false,
        options: [
          { label: 'Login only', description: 'Leave the logout redirect alone.', recommended: true },
          { label: 'Both', description: 'Change login and logout together.' },
        ],
      },
    ];
    const target = {
      id: taskId,
      title: 'Fix the login redirect',
      input: 'Users land on /404 after signing in. Find out why.',
      createdBy: 'user',
      scheduleId: null,
      agent: 'reviewer',
      unreadable: [],
    };
    const place = { machine: 'laptop', workdir: WORKDIR };

    const requests: RequestCase[] = [
      await request(
        'a new task with every option',
        'sealNewTask',
        [
          {
            title: 'Fix the login redirect',
            input: 'Users land on /404 after signing in. Find out why.',
            priority: 'high',
            model: 'opus',
            effort: 'high',
            lane: 'work',
            autoDone: true,
            when: 'backlog',
            parentId: 'tsk000000000',
            place,
            agent: 'reviewer',
            icon: '🐛',
            labels: ['bug', 'auth'],
          },
        ],
        [
          ['title', titleBinding(fullRow)],
          ['input', inputBinding(fullRow)],
          ['agent', agentBinding(fullRow)],
          ['icon', iconBinding(fullRow)],
          ['labels', labelsBinding(fullRow)],
          ['place.workdir', workdirBinding(fullRow)],
        ],
        ['tsk000000010'],
      ),
      await request(
        'a new repeating task without a title',
        'sealNewTask',
        [{ input: 'Summarise the open pull requests.', when: { every: 3_600_000 }, place }],
        [
          ['title', titleBinding(repeatRow)],
          ['input', inputBinding(repeatRow)],
          ['place.workdir', workdirBinding(repeatRow)],
        ],
        ['sch000000010'],
      ),
      await request(
        'a reply',
        'sealReply',
        [taskId, '  Also check the mobile layout.  '],
        [
          ['body', notes('user', 'comment').body],
          ['preview', notes('user', 'comment').preview],
        ],
      ),
      await request(
        'an answer',
        'sealAnswer',
        [
          {
            id: taskId,
            questionNoteId: 'note00000002',
            questions,
            answers: [{ selected: ['Login only'], other: 'Keep the logout redirect as it is.' }],
            message: 'Go with the first option.',
          },
        ],
        [
          ['answers', noteBinding('note.answers', taskId, 'user', 'answer')],
          ['message.body', notes('user', 'answer').body],
          ['message.preview', notes('user', 'answer').preview],
        ],
      ),
      await request(
        'starting an agent proposal',
        'sealStart',
        [
          {
            id: 'tsk000000003',
            status: 'backlog',
            input: 'Bump the lockfile.',
            createdBy: 'agent',
            scheduleId: null,
            unreadable: [],
          },
        ],
        [['', inputBinding({ kind: 'task', id: 'tsk000000003', createdBy: 'user', scheduleId: null, forkOf: null })]],
      ),
      await request(
        'a fork',
        'sealFork',
        [
          {
            parent: {
              id: taskId,
              status: 'needs-me',
              closed: false,
              createdBy: 'user',
              machine: 'laptop',
              sessionId: '0f3a8b1c-5d2e-4c7a-9b6d-1e2f3a4b5c6d',
              workdir: WORKDIR,
              agent: 'reviewer',
              unreadable: [],
            },
            title: 'Try the mobile layout',
            input: 'Check the mobile layout instead.',
          },
        ],
        [
          ['title', titleBinding(forkRow)],
          ['input', inputBinding(forkRow)],
          ['workdir', workdirBinding(forkRow)],
          ['agent', agentBinding(forkRow)],
        ],
        ['tsk000000011'],
      ),
      await request(
        'an edit',
        'sealEdit',
        [{ target, title: 'Fix the sign-in redirect', input: 'Users land on /404 after signing in; fix it.' }],
        [
          ['title', titleBinding(plainRow)],
          ['input', inputBinding(plainRow)],
          ['previous.body', notes('user', 'event').body],
          ['previous.preview', notes('user', 'event').preview],
        ],
      ),
      await request(
        'applying a polished prompt',
        'sealApply',
        [
          {
            polishId: 'polish000001',
            target,
            rewrite: {
              title: 'Fix the redirect after sign-in',
              prompt: 'After signing in, users reach /404. Find the cause.',
            },
          },
        ],
        [
          ['title', titleBinding(plainRow)],
          ['input', inputBinding(plainRow)],
          ['previous.body', notes('user', 'event').body],
          ['previous.preview', notes('user', 'event').preview],
        ],
      ),
      await request(
        'changing the settings of a task',
        'sealConfigure',
        [
          {
            task: { id: taskId, createdBy: 'user', scheduleId: null },
            model: 'opus',
            effort: null,
            lane: 'work',
            autoDone: false,
            icon: '🔧',
            labels: ['infra'],
            place: { machine: 'laptop', workdir: '/home/alice/infra' },
            title: 'Rename the task',
          },
        ],
        [
          ['title', titleBinding(userRow(taskId))],
          ['icon', iconBinding(userRow(taskId))],
          ['labels', labelsBinding(userRow(taskId))],
          ['place.workdir', workdirBinding(userRow(taskId))],
        ],
      ),
      await request(
        'editing a schedule',
        'sealScheduleUpdate',
        [
          {
            id: scheduleId,
            title: 'Weekly dependency check',
            input: 'Look for outdated dependencies.',
            agent: 'reviewer',
            place,
            priority: 'normal',
            model: null,
            autoDone: false,
            repeat: { everyMs: 604_800_000 },
            runsLeft: null,
            until: null,
            maxConcurrent: null,
            unreadable: [],
          },
        ],
        [
          ['title', titleBinding(scheduleRow)],
          ['input', inputBinding(scheduleRow)],
          ['agent', agentBinding(scheduleRow)],
          ['place.workdir', workdirBinding(scheduleRow)],
        ],
      ),
      await request(
        'saving the title rules',
        'sealTitleRulesInput',
        [[{ pattern: '^fix\\b', flags: 'i', icon: '🐛', labels: ['bug'], instruction: 'Start with a verb.' }], 2],
        [['document', titleRulesBinding(3)]],
      ),
      await request(
        'saving the link rules',
        'sealLinks',
        [[{ pattern: 'ABC-(\\d+)', url: 'https://tracker.example/issues/ABC-$1' }], 1],
        [['document', linkRulesBinding(2)]],
      ),
    ];

    const bob = await deriveKeys(dataKey, 'bob');
    const sealBob = sealerFor(bob);
    const importedRef = userRow('tsk000000020');
    const importLines = [
      exportHeaderLine({
        format: 'agent-board-export',
        version: 1,
        exportedAt: T1,
        owner: 'bob',
        keyId: bob.keyId,
        keySlots: created.setup.slots as never,
        transcripts: false,
        prefs: {},
      }),
      exportRowLine('task', {
        id: 'tsk000000020',
        createdBy: 'user',
        scheduleId: null,
        forkOf: null,
        agent: null,
        title: await sealBob(titleBinding(importedRef), 'Imported task'),
        input: await sealBob(inputBinding(importedRef), 'Written by the previous owner.'),
      }),
    ];
    requests.push(
      await request(
        'importing a file of another owner',
        'importBoard',
        [importLines],
        [
          ['0.rows.0.title', titleBinding(importedRef)],
          ['0.rows.0.input', inputBinding(importedRef)],
        ],
      ),
    );
    writeJson('requests.json', { cases: requests });

    const base = (id: string, overrides: Record<string, unknown> = {}) => ({
      id,
      workdir: null,
      pr: null,
      prState: null,
      status: 'needs-me',
      priority: 'normal',
      model: null,
      effort: null,
      requestedLane: null,
      autoDone: false,
      closed: false,
      machine: null,
      sessionId: null,
      next: 'fresh',
      head: null,
      openQuestion: false,
      createdBy: 'user',
      lane: null,
      borrowed: false,
      lastActiveAt: null,
      runStartedAt: null,
      paused: false,
      notBefore: null,
      scheduleId: null,
      wakeAt: null,
      waitCheck: false,
      woken: false,
      proposed: false,
      started: false,
      parentId: null,
      createdAt: T0,
      updatedAt: T1,
      ...overrides,
    });
    const sealedTask = async (row: TaskRow, title: string, input: string, overrides: Record<string, unknown> = {}) => ({
      ...base(row.id, { createdBy: row.createdBy, scheduleId: row.scheduleId, ...overrides }),
      title: await sealWith(titleBinding(row), title),
      input: await sealWith(inputBinding(row), input),
      ...(row.agent ? { agent: await sealWith(agentBinding(row), row.agent) } : {}),
    });
    const fullTask = userRow(taskId, 'reviewer');
    const watch: TaskWatch = {
      id: '0123456789abcdef',
      name: 'ci',
      kind: 'ci',
      label: 'CI #116',
      status: '4 of 7 passed',
      deadline: '2026-11-20T14:20:00.000Z',
    };
    const prUrl = 'https://github.com/acme/app/pull/17';
    const readableTask = async () => ({
      ...(await sealedTask(fullTask, 'Fix the login redirect', '/review the redirect after signing in', {
        status: 'running',
        machine: 'laptop',
        model: 'opus',
        effort: 'high',
        lane: 'work',
        sessionId: '0f3a8b1c-5d2e-4c7a-9b6d-1e2f3a4b5c6d',
      })),
      agent: await sealWith(agentBinding(fullTask), 'reviewer'),
      workdir: await sealWith(workdirBinding(fullTask), WORKDIR),
      icon: await sealWith(iconBinding(fullTask), '🐛'),
      labels: await sealWith(labelsBinding(fullTask), JSON.stringify(['bug', 'auth'])),
      prs: [{ id: 'pr0000000001', pr: await sealPr(sealWith, taskId, prUrl), state: 'open' }],
      promptPrState: 'merged',
      watches: await sealWatches(sealWith, taskId, [watch], 2),
      watchStops: ['fedcba9876543210'],
    });

    const occurrence = { ...userRow('tsk000000002'), scheduleId };
    const fork = userRow('tsk000000004', 'reviewer', taskId);
    const strayTitle = await sealWith(titleBinding(userRow('tsk000000099')), 'Sealed for another task');
    const thread = async () => {
      const comment = await sealNote(
        sealWith,
        { taskId, author: 'agent', kind: 'comment' },
        'The redirect uses the stale session.',
        { suggestion: 'Please restart the dev server and retry.' },
      );
      const asked = await sealQuestions(sealWith, taskId, questions);
      const answered = await sealNote(
        sealWith,
        { taskId, author: 'user', kind: 'answer' },
        'Go with the first option.',
      );
      const queued = await sealNote(sealWith, { taskId, author: 'user', kind: 'comment' }, 'One more thing.');
      const stray = await sealNote(sealWith, { taskId, author: 'user', kind: 'comment' }, 'Sealed as the user.');
      const note = (id: string, at: string, author: string, kind: string, rest: Record<string, unknown>) => ({
        id,
        createdAt: at,
        author,
        kind,
        by: null,
        preview: null,
        ...rest,
      });
      return [
        note('note00000001', T0, 'agent', 'comment', { ...comment }),
        note('note00000002', T0, 'agent', 'question', { body: asked.body, questions: asked.questions }),
        note('note00000003', T1, 'user', 'answer', {
          ...answered,
          questionNoteId: 'note00000002',
          answers: await sealAnswers(sealWith, taskId, questions, [{ selected: ['Login only'] }]),
        }),
        note('note00000004', T1, 'server', 'event', { body: 'Moved from needs-me to todo.' }),
        note('note00000005', T1, 'user', 'comment', { ...queued, pending: true }),
        note('note00000006', T1, 'user', 'comment', {
          ...queued,
          deliveredAt: '2026-11-20T09:45:00.000Z',
        }),
        note('note00000007', T1, 'agent', 'comment', { ...stray }),
      ];
    };

    const run = { taskId, runId: 'run00000001' };
    const dataFor = (seq: number, event: Record<string, unknown>) =>
      sealWith(transcriptBinding('tr.data', run.taskId, run.runId, seq), JSON.stringify(event));
    const reading = {
      seq: 7,
      at: T1,
      parent: null,
      kind: 'context',
      used: 133_600,
      window: 1_000_000,
      threshold: 80,
      model: 'opus',
    };
    const contextWire = { runId: run.runId, seq: 7, at: T1, data: await dataFor(7, reading) };
    const usage = {
      limits: { fiveHour: 80, priority: 'urgent' },
      windows: { fiveHour: { percent: 85, resetsAt: '2026-11-20T14:05:00.000Z', seenAt: T1 } },
      reached: ['fiveHour'],
      held: ['tsk000000001'],
      open: [],
    };
    const machine = (name: string, dirs: string | null, usageValue: string | null = null) => ({
      name,
      createdAt: T0,
      lastSeenAt: T1,
      revokedAt: null,
      clientVersion: '0.8.0',
      clientStatus: 'current',
      dirs,
      dirsUpdatedAt: dirs === null ? null : T1,
      usage: usageValue,
      usageUpdatedAt: usageValue === null ? null : T1,
    });
    const dirsJson = JSON.stringify({
      dirs: [{ path: WORKDIR, label: 'App', repo: 'acme/app' }, { path: '/home/alice/infra' }],
    });
    const catalog = {
      claude: '2.1.326',
      models: [{ value: 'opus', label: 'Opus' }],
      skills: [{ name: 'review', description: 'Reviews a change', argumentHint: '<pr>' }],
      dirs: { [WORKDIR]: [{ name: 'deploy' }] },
    };
    const feed = {
      id: '0123456789abcdef',
      name: 'reviews',
      everyMs: 600_000,
      paused: false,
      runAsked: false,
      history: [],
    };
    const scheduleWire = {
      id: scheduleId,
      title: await sealWith(titleBinding(scheduleRow), 'Weekly dependency check'),
      input: await sealWith(inputBinding(scheduleRow), 'Look for outdated dependencies.'),
      workdir: await sealWith(workdirBinding(scheduleRow), WORKDIR),
      agent: await sealWith(agentBinding(scheduleRow), 'reviewer'),
      icon: await sealWith(iconBinding(scheduleRow), '📦'),
      labels: await sealWith(labelsBinding(scheduleRow), JSON.stringify(['deps'])),
      priority: 'normal',
      model: null,
      effort: null,
      requestedLane: null,
      autoDone: false,
      machine: 'laptop',
      everyMs: 604_800_000,
      cron: null,
      moreCrons: [],
      timezone: null,
      after: null,
      maxConcurrent: 1,
      anchorAt: T0,
      nextRunAt: '2026-11-27T09:00:00.000Z',
      remaining: null,
      until: null,
      paused: false,
      ended: false,
      occurrenceTaskId: 'tsk000000002',
      createdAt: T0,
    };

    const response = async (name: string, opener: string, args: unknown[]): Promise<ResponseCase> => ({
      name,
      opener,
      args,
      opened: JSON.parse(JSON.stringify(await openers[opener]?.(keys, args))),
    });

    const responses: ResponseCase[] = [
      await response('a task of the user with every field sealed', 'openBoardTask', [await readableTask()]),
      await response('an occurrence of a schedule', 'openBoardTask', [
        {
          ...(await sealedTask(occurrence, 'Weekly dependency check', 'Look for outdated dependencies.')),
          workdir: await sealWith(workdirBinding(occurrence), WORKDIR),
        },
      ]),
      await response('a fork of another task', 'openBoardTask', [
        {
          ...(await sealedTask(fork, 'Try the mobile layout', 'Check the mobile layout instead.')),
          forkOf: taskId,
          parentId: taskId,
        },
      ]),
      await response('a title sealed for another task', 'openBoardTask', [
        { ...(await sealedTask(userRow(taskId), 'unused', 'Fix it.')), title: strayTitle },
      ]),
      await response('the cards of a list with a reading and a server event', 'openListedTasks', [
        [
          {
            ...(await readableTask()),
            lastNote: {
              createdAt: T1,
              author: 'agent',
              kind: 'comment',
              preview: await sealWith(
                noteBinding('note.preview', taskId, 'agent', 'comment'),
                'The redirect uses the stale session.',
              ),
            },
            context: contextWire,
          },
          {
            ...(await sealedTask(userRow('tsk000000005'), 'Ship it', 'Ship the release.', { status: 'done' })),
            lastNote: { createdAt: T1, author: 'server', kind: 'event', preview: 'Marked done.' },
            context: null,
          },
        ],
      ]),
      await response('a task with its thread', 'openTaskDetail', [
        {
          task: await readableTask(),
          thread: await thread(),
          followUps: [
            await sealedTask(fork, 'Try the mobile layout', 'Check the mobile layout instead.', {
              forkOf: taskId,
              parentId: taskId,
            }),
          ],
          parent: null,
        },
      ]),
      await response('a schedule', 'openSchedule', [scheduleWire]),
      await response(
        'machines with a listing and a status, and one listing sealed for another machine',
        'openMachines',
        [
          [
            machine(
              'laptop',
              await sealWith(machineDirsBinding('laptop'), dirsJson),
              await sealWith(machineUsageBinding('laptop'), JSON.stringify(usage)),
            ),
            machine('desktop', await sealWith(machineDirsBinding('laptop'), dirsJson)),
          ],
        ],
      ),
      await response('the catalogue of a machine', 'openCatalogs', [
        [
          {
            name: 'laptop',
            catalog: await sealWith(machineCatalogBinding('laptop'), JSON.stringify(catalog)),
            catalogUpdatedAt: T1,
          },
        ],
      ]),
      await response('the shared agents', 'openBoardAgents', [
        {
          version: 2,
          pushedAt: T1,
          document: await sealSharedAgents(sealWith, {
            version: 2,
            agents: { reviewer: { description: 'Reviews a pull request', tools: ['Read', 'Grep'], model: 'opus' } },
          }),
        },
      ]),
      await response('the link rules', 'openBoardLinks', [
        {
          version: 3,
          updatedAt: T1,
          document: await sealLinkRules(sealWith, {
            version: 3,
            rules: [{ pattern: 'ABC-(\\d+)', url: 'https://tracker.example/issues/ABC-$1' }],
          }),
        },
      ]),
      await response('the title rules', 'openBoardTitleRules', [
        {
          version: 4,
          updatedAt: T1,
          document: await sealTitleRules(sealWith, {
            version: 4,
            rules: [{ pattern: '^fix\\b', flags: 'i', icon: '🐛', labels: ['bug'], instruction: 'Start with a verb.' }],
          }),
        },
      ]),
      await response('a result event', 'openEvent', [
        run,
        {
          seq: 3,
          at: T1,
          kind: 'result',
          parent: null,
          outputSize: null,
          data: await dataFor(3, { seq: 3, at: T1, parent: null, kind: 'result', text: 'done', isError: false }),
        },
      ]),
      await response('an event sealed under another position', 'openEvent', [
        run,
        {
          seq: 4,
          at: T1,
          kind: 'result',
          parent: null,
          outputSize: null,
          data: await dataFor(5, { seq: 4, at: T1, parent: null, kind: 'result', text: 'done', isError: false }),
        },
      ]),
      await response('the output of a tool result', 'openOutput', [
        run,
        3,
        await sealWith(
          transcriptBinding('tr.output', run.taskId, run.runId, 3),
          'total 8\ndrwxr-xr-x  2 alice  staff  64 .',
        ),
      ]),
      await response('the feeds of a machine', 'openFeeds', [
        [
          {
            name: 'laptop',
            feeds: await sealMachineFeeds(sealWith, 'laptop', { feeds: [feed] }),
            feedsUpdatedAt: T1,
            feedRequests: ['pause:0123456789abcdef', 'delete:0123456789abcdef'],
            lastSeenAt: T1,
          },
        ],
      ]),
      await response('the context reading of a task', 'openContext', [taskId, contextWire]),
      await response('the runs of a task', 'openRuns', [
        [
          {
            id: run.runId,
            machine: 'laptop',
            sessionId: '0f3a8b1c-5d2e-4c7a-9b6d-1e2f3a4b5c6d',
            eventCount: 12,
            startedAt: T0,
          },
        ],
      ]),
    ];
    writeJson('responses.json', { cases: responses });
  });
});
