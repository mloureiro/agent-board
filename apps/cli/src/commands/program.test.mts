import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { API_VERSION } from '@agent-board/shared';
import { BackendError } from '../backend/backend.mts';
import { UsageError } from '../cli.mts';
import type { ContextOptions, LinkingContext } from '../cli.mts';
import { runBoard } from './program.mts';
import type { ProgramOptions } from './program-shared.mts';
import { CONFIG, fakeBackend, linkTo, task } from '../__tests__/helpers/fakes.mts';
import { fakeRunner, tempDir, watchDef } from '../__tests__/helpers/watch.mts';
import { createWatchStore } from '../watch/store.mts';
import type { WatchStore } from '../watch/store.mts';

const NOW = new Date('2026-01-01T12:00:00Z');

const ID = 'Zt0Test1';

interface Run {
  backend: ReturnType<typeof fakeBackend>;
  printed: string[];
  out: string[];
  err: string[];
  dryRuns: boolean[];
  // The watches of this run's machine, on disk in a temporary directory.
  watches: WatchStore;
  go: (argv: string[], overrides?: ProgramOptions) => Promise<void>;
}

function setup(): Run {
  const backend = fakeBackend([task({ id: ID })]);
  const printed: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const dryRuns: boolean[] = [];
  const context = (dryRun: boolean): LinkingContext => {
    dryRuns.push(dryRun);
    return { config: CONFIG, backend, dryRun, taskLink: linkTo, print: (line) => printed.push(line) };
  };
  const watches = createWatchStore(tempDir());
  const go = (argv: string[], overrides: ProgramOptions = {}) =>
    runBoard(argv, {
      env: {},
      context,
      watches,
      // No test starts a process.
      watchRunner: fakeRunner(),
      writeOut: (text) => out.push(text),
      writeErr: (text) => err.push(text),
      ...overrides,
    });
  return { backend, printed, out, err, dryRuns, watches, go };
}

test('a comment is every word after the task, flags and --dry-run included', async () => {
  const { backend, dryRuns, go } = setup();
  await go(['comment', ID, 'some', 'text', 'with', '--dashes', 'and', '--dry-run', 'inside']);
  assert.deepEqual(backend.writes, [`note ${ID}: some text with --dashes and --dry-run inside`]);
  assert.deepEqual(dryRuns, [false]);
});

test('a comment takes a suggested reply before the task, and never reads one out of its text', async () => {
  const { backend, go } = setup();
  await go(['comment', '--suggest', 'Yes, open the PR.', ID, 'Ready', 'for', 'review']);
  await go(['comment', ID, 'asks', '--suggest', 'nothing']);
  assert.deepEqual(backend.writes, [
    `note ${ID}: Ready for review [suggest: Yes, open the PR.]`,
    `note ${ID}: asks --suggest nothing`,
  ]);
});

test('a comment whose text starts with --suggest or --suggest-file is refused before anything is written', async () => {
  const { backend, go } = setup();
  await assert.rejects(
    go(['comment', ID, '--suggest', 'Merge #120.', '--file', '/tmp/pr.md']),
    /--suggest goes before the task.*board comment --suggest "<reply>"/,
  );
  await assert.rejects(go(['comment', ID, '--suggest=x']), /--suggest goes before the task/);
  await assert.rejects(
    go(['comment', ID, '--suggest-file', '/tmp/a']),
    /--suggest-file goes before the task.*board comment --suggest-file "<path>"/,
  );
  assert.deepEqual(backend.writes, []);
});

test('board pr reports the pull request of a task, and refuses anything but a GitHub pull request URL', async () => {
  const { backend, printed, go } = setup();
  const url = 'https://github.com/acme/app/pull/17741';
  await go(['pr', ID, url]);
  assert.deepEqual(backend.writes, [`pr ${ID} ${url}`]);
  assert.match(printed.join('\n'), new RegExp(`reported ${url} for ${ID}`));
  for (const bad of [`${url}/files`, 'https://github.com/acme/app/issues/3', 'http://github.com/acme/app/pull/1', 'x'])
    await assert.rejects(go(['pr', ID, bad]), UsageError, bad);
  assert.equal(backend.writes.length, 1);
});

test('board pr adds another pull request, and the same URL twice changes nothing but still confirms', async () => {
  const { backend, printed, go } = setup();
  const first = 'https://github.com/acme/app/pull/1';
  const second = 'https://github.com/acme/app/pull/2';
  await go(['pr', ID, first]);
  await go(['pr', ID, second]);
  await go(['pr', ID, first]);
  assert.deepEqual(backend.writes, [`pr ${ID} ${first}`, `pr ${ID} ${second}`]);
  assert.equal(printed.filter((line) => line.startsWith(`reported ${first} for ${ID}`)).length, 2);
});

test('board pr --remove takes a reported pull request off the task', async () => {
  const { backend, printed, go } = setup();
  const first = 'https://github.com/acme/app/pull/1';
  const second = 'https://github.com/acme/app/pull/2';
  await go(['pr', ID, first]);
  await go(['pr', ID, second]);
  await go(['pr', '--remove', ID, first]);
  assert.deepEqual(backend.writes, [`pr ${ID} ${first}`, `pr ${ID} ${second}`, `remove-pr ${ID} pr1`]);
  assert.match(printed.join('\n'), new RegExp(`removed ${first} from ${ID}`));
  assert.deepEqual(
    (await backend.getTask(ID)).prs.map((pr) => pr.url),
    [second],
  );
});

test('board pr --remove of a URL the task does not list changes nothing and says so', async () => {
  const { backend, printed, go } = setup();
  await go(['pr', '--remove', ID, 'https://github.com/acme/app/pull/9']);
  assert.deepEqual(backend.writes, []);
  assert.match(printed.join('\n'), /pull\/9 was not reported for .*nothing changed/);
  await assert.rejects(go(['pr', '--remove', ID, 'x']), UsageError);
});

test('board pr --remove refuses the pull request the prompt names, but removes a reported copy of it', async () => {
  const url = 'https://github.com/acme/app/pull/5';
  const backend = fakeBackend([task({ id: ID, input: `/review-pr ${url} --auto` })]);
  const printed: string[] = [];
  const go = (argv: string[]) =>
    runBoard(argv, {
      env: {},
      context: (dryRun) => ({ config: CONFIG, backend, dryRun, taskLink: linkTo, print: (line) => printed.push(line) }),
      writeOut: () => {},
      writeErr: () => {},
    });
  await assert.rejects(
    go(['pr', '--remove', ID, url]),
    /is the pull request the prompt of .* names, not a reported one/,
  );
  assert.deepEqual(backend.writes, []);
  await go(['pr', ID, url]);
  await go(['pr', '--remove', ID, url]);
  assert.deepEqual(backend.writes, [`pr ${ID} ${url}`, `remove-pr ${ID} pr1`]);
});

test('a suggested reply can come from a file in /tmp, and not from both', async () => {
  const dir = mkdtempSync('/tmp/board-commands-test-');
  try {
    const file = join(dir, 'reply.md');
    writeFileSync(file, 'Go ahead with option B.');
    const { backend, go } = setup();
    await go(['comment', '--suggest-file', file, ID, 'Two options']);
    assert.deepEqual(backend.writes, [`note ${ID}: Two options [suggest: Go ahead with option B.]`]);
    await assert.rejects(go(['comment', '--suggest', 'x', '--suggest-file', file, ID, 'y']), UsageError);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('--dry-run works before the command and among its flags', async () => {
  const { dryRuns, go } = setup();
  await go(['--dry-run', 'tasks']);
  await go(['tasks', '--dry-run']);
  await go(['comment', '--dry-run', ID, 'text']);
  await go(['move', ID, '--dry-run', 'todo']);
  assert.deepEqual(dryRuns, [true, true, true, true]);
});

test('a comment reads stdin for - and a file in /tmp for --file', async () => {
  const { backend, go } = setup();
  await go(['comment', ID, '-'], { readStdin: async () => ' from stdin\n' });
  const dir = mkdtempSync('/tmp/board-commands-test-');
  try {
    writeFileSync(join(dir, 'note.md'), 'from a file\n');
    await go(['comment', ID, '--file', join(dir, 'note.md')]);
    await assert.rejects(go(['comment', ID, '--file']), UsageError);
    await assert.rejects(go(['comment', ID, '--file', join(dir, 'note.md'), 'extra']), UsageError);
  } finally {
    rmSync(dir, { recursive: true });
  }
  assert.deepEqual(backend.writes, [`note ${ID}: from stdin`, `note ${ID}: from a file`]);
});

test('an empty comment is refused', async () => {
  const { go } = setup();
  await assert.rejects(go(['comment', ID]), /the text is missing/);
});

test('move takes the status as one word, two words or a quoted phrase, and never reads stdin', async () => {
  const { backend, go } = setup();
  await go(['move', ID, 'Needs', 'me']);
  await go(['move', ID, 'needs-me']);
  await go(['move', ID, 'Needs me']);
  assert.deepEqual(backend.writes, [
    `status ${ID} -> needs-me`,
    `status ${ID} -> needs-me`,
    `status ${ID} -> needs-me`,
  ]);
  await assert.rejects(go(['move', ID, '-'], { readStdin: async () => 'todo' }), /unknown status "-"/);
  await assert.rejects(go(['move', ID, 'Someday']), UsageError);
});

test('schedule: a prompt after -- may start with dashes, and everything after the first word is prompt', async () => {
  const { backend, go } = setup();
  await go(['schedule', '--new', '--priority', 'high', '--', '--weird', 'prompt']);
  await go(['schedule', '--new', '/review-pr', 'https://github.com/o/r/pull/1', '--auto']);
  await go(['schedule', '--new', '--title=With equals', 'Look', 'at', '--hold']);
  assert.deepEqual(backend.writes, [
    'create --weird prompt | --weird prompt | ',
    'create /review-pr https://github.com/o/r/pull/1 --auto | /review-pr https://github.com/o/r/pull/1 --auto | review-pr',
    'create With equals | Look at --hold | ',
  ]);
});

test('schedule --agent: the agent must be defined in this machine’s config.json, so a typo fails before anything is written', async () => {
  const backend = fakeBackend([]);
  const configs = {
    agents: {
      reviewer: {
        allowedTools: [],
        disallowedTools: [],
        env: [],
        mcpServers: [],
        description: 'Reviews.',
        prompt: 'You review.',
        tools: ['Read'],
      },
    },
    agentErrors: { broken: 'tools must be a list' },
  };
  const go = (argv: string[]) =>
    runBoard(argv, {
      env: {},
      context: (dryRun) => ({
        config: { ...CONFIG, ...configs },
        backend,
        dryRun,
        taskLink: linkTo,
        print: () => undefined,
      }),
      writeOut: () => undefined,
      writeErr: () => undefined,
    });
  await assert.rejects(go(['schedule', '--new', '--agent', 'reveiwer', 'x']), (error: Error) => {
    assert.ok(error instanceof UsageError);
    assert.match(error.message, /no agents\.reveiwer in config\.json on here; it defines reviewer/);
    return true;
  });
  await assert.rejects(go(['schedule', '--new', '--agent', 'broken', 'x']), /\(tools must be a list\)/);
  assert.deepEqual(backend.writes, []);
  await go(['schedule', '--new', '--agent', 'reviewer', 'x']);
  assert.deepEqual(backend.writes, ['create x | x | ']);
});

test('schedule: an unknown flag before the prompt fails, and says how to start a prompt with dashes', async () => {
  const { backend, go } = setup();
  await assert.rejects(go(['schedule', '--hodl', 'x']), (error: Error) => {
    assert.ok(error instanceof UsageError);
    assert.match(error.message, /unknown option '--hodl'/);
    assert.match(error.message, /Did you mean --hold\?/);
    assert.ok(error.details.some((line) => line.includes('put -- before it')));
    return true;
  });
  assert.deepEqual(backend.writes, []);
});

test('a usage error carries the usage of its own command', async () => {
  const { go } = setup();
  await assert.rejects(go(['comment', ID]), (error: Error) => {
    assert.ok(error instanceof UsageError);
    assert.equal(error.details[0], 'usage: board comment [options] <task> <text...|-|--file <path>>');
    assert.equal(error.details[1], 'Run "board help comment" for the details.');
    return true;
  });
  await assert.rejects(go(['shw']), (error: Error) => {
    assert.ok(error instanceof UsageError);
    assert.match(error.message, /unknown command 'shw'\n\(Did you mean show\?\)/);
    assert.deepEqual(error.details, ['usage: board <command> [options]', 'Run "board help" for the commands.']);
    return true;
  });
  await assert.rejects(go(['tasks', 'extra']), /too many arguments/);
});

test('help and version print and end normally, help of a command lists flags and examples', async () => {
  const { out, go } = setup();
  const printed = async (argv: string[], overrides?: ProgramOptions): Promise<string> => {
    out.length = 0;
    await go(argv, overrides);
    return out.join('');
  };
  const overview = await printed([]);
  assert.equal(await printed(['--help']), overview);
  assert.equal(await printed(['help']), overview);
  assert.match(overview, /Tasks:[\s\S]*Scheduling:[\s\S]*Setup:/);
  assert.doesNotMatch(overview, /internal/);
  const help = await printed(['help', 'schedule']);
  assert.equal(await printed(['schedule', '--help']), help);
  assert.match(help, /Usage: board schedule/);
  assert.match(help, /--every <duration>/);
  assert.match(help, /Examples:/);
  assert.equal(await printed(['--version'], { version: '1.2.3-dev' }), `board 1.2.3-dev (api ${API_VERSION})\n`);
});

test('help text inside a comment is text, not a request for help', async () => {
  const { backend, out, go } = setup();
  await go(['comment', ID, 'see', '--help', 'and', '-h']);
  assert.deepEqual(out, []);
  assert.deepEqual(backend.writes, [`note ${ID}: see --help and -h`]);
});

test('tasks, show, comment and move need no config file', async () => {
  const backend = fakeBackend([task({ id: ID })]);
  const context = (): LinkingContext => ({
    get config(): never {
      throw new Error('the config was read');
    },
    backend,
    dryRun: false,
    taskLink: linkTo,
    print: () => undefined,
  });
  for (const argv of [['tasks'], ['show', ID], ['comment', ID, 'hi'], ['move', ID, 'done']])
    await runBoard(argv, { env: {}, context });
});

test('--dry-run at the start or end of the text is a usage error; one in the middle is text', async () => {
  const { backend, go } = setup();
  await assert.rejects(
    go(['comment', ID, 'done', '--dry-run']),
    /--dry-run goes before the text.*board comment --dry-run/,
  );
  await assert.rejects(go(['comment', ID, '--dry-run', 'hello']), /--dry-run goes before the text/);
  assert.deepEqual(backend.writes, []);
  await go(['comment', ID, 'a', '--dry-run', 'b']);
  assert.deepEqual(backend.writes, [`note ${ID}: a --dry-run b`]);
});

test('schedule: a prompt ending in --dry-run needs an explicit --, and the error names both ways out', async () => {
  const { backend, go } = setup();
  await assert.rejects(go(['schedule', '--new', '/review-pr', '17', '--dry-run']), (error: Error) => {
    assert.match(
      error.message,
      /put --dry-run before the prompt \(board schedule --dry-run <prompt...>\), or put -- before/,
    );
    return true;
  });
  assert.deepEqual(backend.writes, []);
  await go(['schedule', '--new', '--', '/review-pr', '17', '--dry-run']);
  assert.deepEqual(backend.writes, ['create /review-pr 17 --dry-run | /review-pr 17 --dry-run | review-pr']);
  await go(['schedule', '--new', '/review-pr', '--dry-run', '17']);
});

test('schedule and add need a config.json; the other commands fall back to the defaults', async () => {
  const seen: boolean[] = [];
  const backend = fakeBackend([task({ id: ID })]);
  const dir = mkdtempSync('/tmp/board-commands-test-');
  try {
    writeFileSync(join(dir, 'p.md'), 'follow up');
    const context = (_dryRun: boolean, { optionalConfig = false } = {}): LinkingContext => {
      seen.push(optionalConfig);
      return { config: CONFIG, backend, dryRun: false, taskLink: linkTo, print: () => undefined };
    };
    await runBoard(['tasks'], { env: {}, context });
    await runBoard(['schedule', '--new', 'x'], { env: {}, context });
    await runBoard(['add', '--title', 't', '--file', join(dir, 'p.md')], { env: {}, context });
  } finally {
    rmSync(dir, { recursive: true });
  }
  assert.deepEqual(seen, [true, false, false]);
});

test('help for an unknown command and a bare --dry-run are plain', async () => {
  const { out, err, go } = setup();
  await assert.rejects(go(['help', 'nosuch']), /unknown command 'nosuch'/);
  await go(['--dry-run']);
  assert.match(out.join(''), /^Usage: board/);
  assert.deepEqual(err, []);
});

// The invocations agents use today: the run rules and the hook's messages in the source, and the selftest skills.
function boardCommands(): string[] {
  const sources = [
    readFileSync(new URL('../worker/prompts.mts', import.meta.url), 'utf8'),
    readFileSync(new URL('../worker/hook.mts', import.meta.url), 'utf8'),
    ...readdirSync(new URL('../__tests__/fixtures/skills/', import.meta.url)).map((name) =>
      readFileSync(new URL(`../__tests__/fixtures/skills/${name}/SKILL.md`, import.meta.url), 'utf8'),
    ),
  ];
  // The sources quote commands in template literals, so their backticks are escaped.
  const spans = sources.flatMap((source) =>
    [...source.matchAll(/\\?`(board [^`\\]+)\\?`/g)].map((match) => match[1] ?? ''),
  );
  return [...new Set(spans)].filter(
    (span) => !/^board (comment|move|ask|add|show|tasks|pr)$|^board internal /.test(span),
  );
}

function words(command: string, files: { questions: string; prompt: string }): string[] {
  const concrete = command
    .replaceAll('${task.id}', ID)
    .replaceAll('${taskId}', ID)
    .replaceAll('${id}', ID)
    .replaceAll('<task>', ID)
    .replace(/<path>/g, files.prompt)
    .replace(/<(?:pr-)?url>/g, 'https://github.com/acme/app/pull/1')
    .replace(/\/tmp\/pr-[^/]*-questions\.json/, files.questions)
    .replace(/<[^>]*>/g, 'x');
  return [...concrete.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? '').slice(1);
}

test('every board command in the run rules, the hook messages and the selftest skills parses', async () => {
  const dir = mkdtempSync('/tmp/board-commands-test-');
  const questions = join(dir, 'pr-questions.json');
  const prompt = join(dir, 'prompt.md');
  writeFileSync(
    questions,
    JSON.stringify({
      questions: [
        {
          header: 'Color',
          question: 'Which?',
          multiSelect: false,
          options: [
            { label: 'Red', description: '' },
            { label: 'Blue', description: '' },
          ],
        },
      ],
    }),
  );
  writeFileSync(prompt, 'do the thing');
  try {
    const commands = boardCommands();
    assert.ok(commands.length >= 8, `found ${commands.length} commands`);
    const verbs = new Set<string>();
    for (const command of commands) {
      const { backend, go, watches } = setup();
      const argv = words(command, { questions, prompt });
      // A wait needs a running task on this machine; its check goes to a store in memory.
      if (['wait', 'watch', 'watches', 'unwatch'].includes(argv[0] ?? ''))
        Object.assign(backend.tasks[0]!, {
          status: 'running',
          machine: CONFIG.machine,
          prs: [{ id: 'p1', url: 'https://github.com/acme/app/pull/7', state: null }],
        });
      // `unwatch` needs something to stop; the runner answers the gh calls of a ci watch and fails every other command.
      watches.write(watchDef({ task: ID, name: 'x', source: { kind: 'timer' }, everyMs: 0 }));
      // A stream is only taken while the watch unit runs.
      watches.touchHeartbeat(NOW);
      const inRun = { env: { AGENT_BOARD_TASK: ID }, cwd: '/work/cosuno', now: () => NOW };
      verbs.add(argv[0] ?? '');
      await go(argv, inRun).catch((error: unknown) => {
        throw new Error(`"${command}" does not parse: ${error instanceof Error ? error.message : String(error)}`);
      });
      const action = backend.writes[0] ?? '';
      const expected: Record<string, RegExp> = {
        comment: new RegExp(
          `^note ${ID}: ${argv
            .slice(argv.indexOf(ID) + 1)
            .join(' ')
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( \\[suggest: .*\\])?$`,
        ),
        move: /^status Zt0Test1 -> (needs-me|done)$/,
        pr: /^pr Zt0Test1 https:\/\/github\.com\/acme\/app\/pull\/1$/,
        ask: /^ask Zt0Test1: Color$/,
        add: /^create .* \| do the thing \| $/,
        wait: /^wait Zt0Test1 until \S+( check)?: x/,
        watch: /^watches Zt0Test1 /,
        unwatch: /^watches Zt0Test1 /,
      };
      const verb = argv[0] ?? '';
      if (verb in expected) assert.match(action, expected[verb] as RegExp, command);
      else assert.deepEqual(backend.writes, [], command);
    }
    for (const verb of ['comment', 'move', 'ask', 'add', 'show', 'watch', 'pr'])
      assert.ok(verbs.has(verb), `no ${verb} command found in the sources`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('ask and add keep their flag shapes', async () => {
  const dir = mkdtempSync('/tmp/board-commands-test-');
  const questions = join(dir, 'q.json');
  writeFileSync(
    questions,
    JSON.stringify({
      questions: [
        {
          header: 'Q',
          question: 'Which?',
          multiSelect: false,
          options: [
            { label: 'A', description: '' },
            { label: 'B', description: '' },
          ],
        },
      ],
    }),
  );
  writeFileSync(join(dir, 'p.md'), 'follow up');
  try {
    const { backend, go } = setup();
    await go(['ask', ID, '--file', questions]);
    await go(['ask', ID, `--file=${questions}`]);
    await go(['add', '--file', join(dir, 'p.md'), '--title', 'Fix it', '--parent', ID, '--priority', 'low']);
    await assert.rejects(go(['ask', ID]), /required option '--file <path>' not specified/);
    await assert.rejects(go(['add', '--title', 't']), /required option '--file <path>' not specified/);
    await assert.rejects(go(['add', '--title', 't', '--file', '/tmp/x', '--tag', 'l']), /unknown option '--tag'/);
    assert.deepEqual(backend.writes, [`ask ${ID}: Q`, `ask ${ID}: Q`, 'create Fix it | follow up | ']);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('internal dispatch, listen and worker say they need Linux or macOS elsewhere', async () => {
  for (const argv of [
    ['internal', 'dispatch'],
    ['internal', 'listen'],
    ['internal', 'worker', ID],
  ])
    await assert.rejects(
      runBoard(argv, { env: {}, platform: 'win32' }),
      /needs Linux with systemd or macOS; this is win32/,
      argv.join(' '),
    );
});

test('internal units prints the schema-1 units without reading the config or the credentials', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'config.json'), '{ not json');
  writeFileSync(join(dir, 'env'), '\u0000\u0001 garbage');
  const { err, go, out } = setup();
  await go(['internal', 'units'], { env: { AGENT_BOARD_CONFIG_DIR: dir, HOME: '/Users/me' }, platform: 'darwin' });
  assert.equal(out.length, 1);
  assert.ok(out[0]?.endsWith('\n'));
  const parsed = JSON.parse(out[0] ?? '') as { schema: number; units: { name: string }[] };
  assert.equal(parsed.schema, 1);
  assert.deepEqual(
    parsed.units.map((unit) => unit.name),
    ['dispatch', 'listen', 'watch'],
  );
  assert.deepEqual(err, []);
});

test('wait --in parks a running task until then, and stores no check', async () => {
  const { backend, go, printed, watches } = setup();
  Object.assign(backend.tasks[0]!, { status: 'running', machine: CONFIG.machine });
  await go(['wait', ID, '--in', '20m', '--reason', 'the deploy settles'], { cwd: '/w', now: () => NOW });
  assert.deepEqual(backend.writes, [
    `wait ${ID} until 2026-01-01T12:20:00.000Z: the deploy settles\n\nWaiting until ${new Date('2026-01-01T12:20:00Z').toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' })}.`,
  ]);
  assert.equal(backend.tasks[0]?.status, 'waiting');
  assert.deepEqual(watches.list(ID).defs, []);
  assert.ok(printed.some((line) => line.includes('end your turn now')));
});

test('wait --check stores a command watch named wait on this machine, keeps the command off the board, and defaults to 2m and 2h', async () => {
  const { backend, go, watches } = setup();
  Object.assign(backend.tasks[0]!, { status: 'running', machine: CONFIG.machine });
  await go(['wait', ID, '--check', 'gh pr checks 17741 --required'], {
    cwd: '/work/cosuno/apps/cli',
    now: () => NOW,
    env: { AGENT_BOARD_TASK: ID, AGENT_BOARD_START_DIR: '/work/cosuno' },
  });
  const stored = watches.read(ID, 'wait');
  assert.deepEqual(
    { ...stored, id: undefined },
    {
      id: undefined,
      name: 'wait',
      task: ID,
      source: {
        kind: 'command',
        command: 'gh pr checks 17741 --required',
        cwd: '/work/cosuno/apps/cli',
        settingsDir: '/work/cosuno',
      },
      everyMs: 120_000,
      createdAt: NOW.toISOString(),
      deadline: '2026-01-01T14:00:00.000Z',
    },
  );
  assert.equal(backend.writes.length, 2);
  assert.match(backend.writes[0] ?? '', /^wait Zt0Test1 until 2026-01-01T14:00:00.000Z check: Waiting for a check\./);
  assert.ok(!(backend.writes[0] ?? '').includes('gh pr checks'));
  // The board is told the check as a command watch, without the command.
  assert.match(
    backend.writes[1] ?? '',
    /^watches Zt0Test1 \[\{.*"name":"wait","kind":"command","label":"command, every 2m"/,
  );
  assert.ok(!(backend.writes[1] ?? '').includes('gh pr checks'));
});

test('wait --check is refused in an agent run (AGENT_BOARD_RESTRICTED), and a timer is not', async () => {
  const { backend, go, watches } = setup();
  Object.assign(backend.tasks[0]!, { status: 'running', machine: CONFIG.machine });
  await assert.rejects(
    go(['wait', ID, '--check', 'true'], { cwd: '/w', now: () => NOW, env: { AGENT_BOARD_RESTRICTED: '1' } }),
    /runs as an agent.*--in or --at only/,
  );
  assert.deepEqual(watches.list(ID).defs, []);
  assert.deepEqual(backend.writes, []);
  await go(['wait', ID, '--in', '20m'], { cwd: '/w', now: () => NOW, env: { AGENT_BOARD_RESTRICTED: '1' } });
  assert.equal(backend.tasks[0]?.status, 'waiting');
});

test('wait --check is refused for a task of another machine, and a refused wait drops its watch', async () => {
  const other = setup();
  Object.assign(other.backend.tasks[0]!, { status: 'running', machine: 'elsewhere' });
  await assert.rejects(
    other.go(['wait', ID, '--check', 'true'], { cwd: '/w', now: () => NOW }),
    /runs on elsewhere, not on here/,
  );
  assert.deepEqual(other.watches.list(ID).defs, []);

  const done = setup();
  Object.assign(done.backend.tasks[0]!, { status: 'running', machine: CONFIG.machine });
  done.backend.wait = async () => {
    throw new BackendError('wait: the task is closed, not running', 409);
  };
  await assert.rejects(done.go(['wait', ID, '--check', 'true'], { cwd: '/w', now: () => NOW }), /cannot wait/);
  assert.deepEqual(done.watches.list(ID).defs, []);

  // A failure that may have reached the board keeps the watch; the next tick drops it if the task does not wait.
  done.backend.wait = async () => {
    throw new BackendError('wait: 502 Bad Gateway', 502);
  };
  await assert.rejects(done.go(['wait', ID, '--check', 'true'], { cwd: '/w', now: () => NOW }), /502/);
  assert.deepEqual(
    done.watches.list(ID).defs.map((def) => def.name),
    ['wait'],
  );
});

test('wait takes exactly one end, --every and --timeout only with --check, and at most 7 days', async () => {
  const { backend, go } = setup();
  Object.assign(backend.tasks[0]!, { status: 'running', machine: CONFIG.machine });
  const opts = { cwd: '/w', now: () => NOW };
  await assert.rejects(go(['wait', ID], opts), /exactly one of --in, --at or --check/);
  await assert.rejects(go(['wait', ID, '--in', '5m', '--check', 'true'], opts), /exactly one/);
  await assert.rejects(go(['wait', ID, '--in', '5m', '--timeout', '1h'], opts), /go with --check/);
  await assert.rejects(go(['wait', ID, '--check', 'true', '--every', '30m', '--timeout', '8d'], opts), /at most/);
  await assert.rejects(go(['wait', ID, '--check', 'true', '--every', '0m'], opts), /--every/);
  await assert.rejects(go(['move', ID, 'waiting']), /board wait/);
  assert.deepEqual(backend.writes, []);
});

function keyedRun() {
  const old = task({
    id: 'Old0Task',
    input: '/review-pr https://github.com/o/r/pull/7 --auto',
    head: 'sha1',
    agent: 'reviewer',
  });
  old.status = 'needs-me';
  const backend = fakeBackend([old]);
  backend.keys.set('Old0Task', 'https://github.com/o/r/pull/7');
  const printed: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const go = (argv: string[], overrides: ProgramOptions = {}) =>
    runBoard(argv, {
      env: {},
      context: (dryRun) => ({
        config: {
          ...CONFIG,
          agents: {
            reviewer: {
              allowedTools: [],
              disallowedTools: [],
              env: [],
              mcpServers: [],
              description: 'Reviews.',
              prompt: 'You review.',
              tools: ['Read'],
            },
          },
        },
        backend,
        dryRun,
        taskLink: linkTo,
        print: (line) => printed.push(line),
      }),
      writeOut: (text) => out.push(text),
      writeErr: (text) => err.push(text),
      ...overrides,
    });
  return { backend, printed, out, err, go };
}
const PR_FLAGS = ['--agent', 'reviewer', '--key', 'https://github.com/o/r/pull/7'];

test('schedule --key prints created, exists or requeued with the id and URL, and --json adds result, status and reason', async () => {
  const { backend, printed, out, go } = keyedRun();
  await go(['schedule', ...PR_FLAGS, '--version', 'sha1', '/review-pr', 'x']);
  await go(['schedule', ...PR_FLAGS, '--version', 'sha2', '/review-pr', 'x']);
  await go(['schedule', '--agent', 'reviewer', '--key', 'https://github.com/o/r/pull/8', '/review-pr', 'y']);
  assert.deepEqual(printed, [
    `exists Old0Task ${linkTo('Old0Task')} (same-version)`,
    `requeued Old0Task ${linkTo('Old0Task')}`,
    `created new ${linkTo('new')}`,
  ]);
  assert.equal(backend.tasks[0]?.status, 'todo');

  out.length = 0;
  await go(['schedule', '--json', ...PR_FLAGS, '--version', 'sha2', '/review-pr', 'x']);
  await go(['schedule', '--json', '--agent', 'reviewer', '--key', 'k2', 'z']);
  assert.deepEqual(
    out.map((text) => JSON.parse(text) as unknown),
    [
      { id: 'Old0Task', url: linkTo('Old0Task'), result: 'exists', status: 'todo', reason: 'same-version' },
      { id: 'new', url: linkTo('new'), result: 'created', status: 'todo' },
    ],
  );
});

test('schedule --key never asks the duplicate check, and is refused inside a board run', async () => {
  const { backend, go } = keyedRun();
  await assert.rejects(
    go(['schedule', ...PR_FLAGS, '--version', 'sha2', 'x'], { env: { AGENT_BOARD_TASK: 'Zt0Test1' } }),
    /board schedule is not available inside a board run/,
  );
  assert.equal(backend.tasks[0]?.status, 'needs-me');
  assert.deepEqual(backend.writes, []);
});

test('schedule --version is not the program version, and needs --key', async () => {
  const { go } = keyedRun();
  await assert.rejects(go(['schedule', '--version', 'sha', 'x']), /--version belongs to --key/);
});

test('move --expect moves only while the task is in that status, and exits 3 with a message otherwise', async () => {
  const { backend, err, go } = setup();
  await go(['move', ID, 'done', '--expect', 'todo']);
  assert.deepEqual(backend.writes, [`status ${ID} -> done`]);
  await assert.rejects(go(['move', ID, 'needs-me', '--expect', 'todo']), (error: Error) => {
    assert.equal((error as { exitCode?: number }).exitCode, 3);
    return true;
  });
  assert.equal(err.join(''), `board: ${ID} is not in todo any more; nothing was moved\n`);
  assert.equal(backend.tasks[0]?.status, 'done');
  await assert.rejects(go(['move', ID, 'done', '--expect', 'soon']), UsageError);
});

test('move --expect is refused inside a board run', async () => {
  const { backend, go } = setup();
  await assert.rejects(
    go(['move', ID, 'needs-me', '--expect', 'todo'], { env: { AGENT_BOARD_TASK: ID } }),
    /not available inside a board run/,
  );
  assert.deepEqual(backend.writes, []);
});

test('inside a board run the context names the run from the environment, when both ids are well formed', async () => {
  const RUN = 'r'.repeat(22);
  const runs: unknown[] = [];
  const { backend, go } = setup();
  const context = (dryRun: boolean, options: ContextOptions): LinkingContext => {
    runs.push(options.run?.());
    return { config: CONFIG, backend, dryRun, taskLink: linkTo, print: () => undefined };
  };
  await go(['move', ID, 'needs-me'], { env: { AGENT_BOARD_TASK: ID, AGENT_BOARD_RUN: RUN }, context });
  await go(['move', ID, 'needs-me'], { env: { AGENT_BOARD_TASK: ID }, context });
  await go(['move', ID, 'needs-me'], { env: { AGENT_BOARD_TASK: ID, AGENT_BOARD_RUN: 'not a run' }, context });
  await go(['move', ID, 'needs-me'], { env: {}, context });
  assert.deepEqual(runs, [{ task: ID, run: RUN }, undefined, undefined, undefined]);
});

test('a move the board refuses for the run is a usage error that tells the agent to end its turn', async () => {
  const { backend, go } = setup();
  backend.updateTask = async () => {
    throw new BackendError('update-task: the task is needs-me, no longer running in this run', 409, true);
  };
  await assert.rejects(
    go(['move', ID, 'done'], { env: { AGENT_BOARD_TASK: ID } }),
    (error: Error) =>
      error instanceof UsageError &&
      error.message.startsWith(
        `${ID} was not moved: update-task: the task is needs-me, no longer running in this run.`,
      ) &&
      error.message.includes('do not move it again, end your turn'),
  );
});
