import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SHELLS, renderCompletion, completionModel } from './completion.mts';
import type { Shell } from './completion.mts';
import type { LinkingContext } from '../cli.mts';
import { buildProgram, runBoard } from './program.mts';
import { CONFIG, fakeBackend, linkTo, schedule, task } from '../__tests__/helpers/fakes.mts';

const model = completionModel(buildProgram({ env: {} }));
const VISIBLE = [
  'tasks',
  'show',
  'attach',
  'comment',
  'pr',
  'move',
  'ask',
  'wait',
  'watch',
  'watches',
  'unwatch',
  'events',
  'add',
  'polish',
  'task',
  'schedule',
  'schedules',
  'dirs',
  'feeds',
  'plugins',
  'config',
  'agents',
  'delay',
  'init',
  'doctor',
  'setup',
  'restart',
  'logs',
  'self-update',
  'completion',
  'example',
  'help',
];

function script(shell: Shell): string {
  return renderCompletion(shell, model);
}

test('the model lists the visible commands only, with their flags', () => {
  assert.deepEqual(
    model.commands.map((command) => command.name),
    VISIBLE,
  );
  const flags = (name: string): string[] => model.commands.find((command) => command.name === name)?.flags ?? [];
  assert.ok(['--all', '--status', '--json', '--dry-run'].every((flag) => flags('tasks').includes(flag)));
  assert.ok(flags('attach').includes('--fork'));
  assert.ok(flags('schedule').includes('--cron') && flags('add').includes('--priority'));
  assert.deepEqual(model.flagValues['--status'], ['backlog', 'todo', 'running', 'waiting', 'needs-me', 'done']);
  assert.ok(
    ['--in', '--at', '--check', '--every', '--timeout', '--reason'].every((flag) => flags('wait').includes(flag)),
  );
  assert.deepEqual(model.flagValues['--priority'], ['urgent', 'high', 'normal', 'low']);
  assert.deepEqual(model.flagValues['--model'], ['fable', 'opus', 'sonnet', 'haiku']);
  assert.deepEqual(model.flagValues['--effort'], ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(model.flagValues['--type'], ['created', 'moved', 'changed', 'closed', 'removed', 'note']);
  assert.ok(model.taskFlags.includes('--task') && model.taskFlags.includes('--parent'));
});

test('restart completes the unit names, and logs the units and then the task ids', () => {
  const positionals = (name: string) => model.commands.find((command) => command.name === name)?.positionals;
  assert.deepEqual(positionals('restart'), ['unit']);
  assert.deepEqual(positionals('logs'), ['log-target']);
  assert.ok(script('bash').includes('compgen -W "dispatch listen watch $(__board_ids tasks)"'));
  assert.ok(script('zsh').includes('compadd -- dispatch listen watch; __board_ids tasks'));
  assert.ok(script('fish').includes("'__board_at 1 restart logs' -a 'dispatch listen watch'"));
  assert.ok(script('fish').includes("'__board_at 1 logs' -a '(__board_ids tasks)'"));
});

test('task completes its id, then set or unset, then the setting', () => {
  assert.deepEqual(model.commands.find((command) => command.name === 'task')?.positionals, [
    'task',
    'task-action',
    'task-key',
  ]);
  assert.ok(script('bash').includes('compgen -W "set unset"'));
  assert.ok(script('bash').includes('compgen -W "priority model effort lane auto-done icon labels dir prompt"'));
  assert.ok(
    script('fish').includes("'__board_at 3 task' -a 'priority model effort lane auto-done icon labels dir prompt'"),
  );
});

for (const shell of SHELLS) {
  test(`the ${shell} script names every visible command, no hidden one, and the values`, () => {
    const text = script(shell);
    assert.ok(text.length > 500);
    for (const name of VISIBLE) assert.ok(new RegExp(`\\b${name}\\b`).test(text), name);
    assert.ok(!/\binternal\b/.test(text), 'internal');
    assert.ok(text.includes('needs-me') && text.includes('urgent') && text.includes('pause'));
    assert.ok(text.includes('__complete'));
  });
}

function shellExists(shell: string): boolean {
  return spawnSync(shell, ['--version'], { stdio: 'ignore' }).status === 0;
}

// Without zsh or fish the check cannot run: that is a failure on CI, where the job installs them, and a skip elsewhere.
function requireShell(shell: string, context: TestContext): boolean {
  if (shellExists(shell)) return true;
  if (process.env['CI']) assert.fail(`${shell} is not installed, but CI must run its completion checks`);
  context.skip(`${shell} is not installed; its script was not checked`);
  return false;
}

function writeScript(dir: string, shell: Shell): string {
  const path = join(dir, shell);
  writeFileSync(path, script(shell));
  return path;
}

test('the bash script is valid bash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-completion-test-'));
  try {
    assert.equal(spawnSync('bash', ['-n', writeScript(dir, 'bash')]).status, 0, 'bash -n');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('the zsh script parses', (context) => {
  if (!requireShell('zsh', context)) return;
  const dir = mkdtempSync(join(tmpdir(), 'board-completion-test-'));
  try {
    const result = spawnSync('zsh', ['-n', writeScript(dir, 'zsh')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('the fish script parses', (context) => {
  if (!requireShell('fish', context)) return;
  const dir = mkdtempSync(join(tmpdir(), 'board-completion-test-'));
  try {
    const result = spawnSync('fish', ['--no-execute', writeScript(dir, 'fish')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// How bash splits a command line: at spaces, and at ":" too (COMP_WORDBREAKS), which stays a word of its own.
function bashWords(words: string[]): string[] {
  return words.flatMap((word) => (word === '' ? [''] : word.split(/(:)/).filter((piece) => piece !== '')));
}

// Runs the bash script and returns what it offers after `line` for the word being typed.
function bashOffers(line: string[], current: string, cwd?: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'board-completion-test-'));
  try {
    writeFileSync(join(dir, 'board.bash'), script('bash'));
    const words = bashWords(['board', ...line, current])
      .map((word) => `'${word}'`)
      .join(' ');
    const program = `
board() { if [ "$1" = __complete ] && [ "$2" = tasks ]; then printf 'Ab3dEf9x\\tFirst\\nZk7mNp2q\\tSecond\\n'; elif [ "$2" = schedules ]; then printf 'Sc1aBcDe\\tSweep\\n'; fi; }
source ${join(dir, 'board.bash')}
COMP_WORDS=(${words}); COMP_CWORD=$((\${#COMP_WORDS[@]} - 1))
_board
printf '%s\\n' "\${COMPREPLY[@]}"`;
    const result = spawnSync('bash', ['-c', program], { encoding: 'utf8', ...(cwd ? { cwd } : {}) });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.split('\n').filter((entry) => entry !== '');
  } finally {
    rmSync(dir, { recursive: true });
  }
}

test('the bash script completes commands, task ids, statuses, priorities and schedule actions', () => {
  assert.ok(bashOffers([], 'ta').includes('tasks'));
  assert.ok(bashOffers([], 'tasks').length >= 1);
  assert.deepEqual(bashOffers(['show'], ''), ['Ab3dEf9x', 'Zk7mNp2q']);
  assert.deepEqual(bashOffers(['show'], 'Ab'), ['Ab3dEf9x']);
  assert.deepEqual(bashOffers(['move', 'Ab3dEf9x'], 'n'), ['needs-me']);
  assert.deepEqual(bashOffers(['tasks', '--status'], 'd'), ['done']);
  assert.deepEqual(bashOffers(['add', '--priority'], 'h'), ['high']);
  assert.deepEqual(bashOffers(['schedule', '--model'], 'o'), ['opus']);
  assert.deepEqual(bashOffers(['add', '--parent'], 'Z'), ['Zk7mNp2q']);
  assert.deepEqual(bashOffers(['events', '--task'], 'Z'), ['Zk7mNp2q']);
  assert.deepEqual(bashOffers(['events', '--type'], 'n'), ['note']);
  assert.deepEqual(bashOffers(['events', '--status'], 'n'), ['needs-me']);
  assert.deepEqual(bashOffers(['schedules'], 'p'), ['pause']);
  assert.deepEqual(bashOffers(['dirs'], ''), ['list', 'add', 'rm', 'set', 'unset']);
  assert.deepEqual(bashOffers(['agents'], ''), ['list', 'show', 'export', 'add', 'rm']);
  assert.deepEqual(bashOffers(['dirs', 'set'], ''), ['label', 'repo', 'default', 'lane', 'ciIgnore']);
  assert.deepEqual(bashOffers(['dirs', 'unset'], 'd'), ['default']);
  assert.deepEqual(bashOffers(['dirs', 'add'], ''), [], 'only set and unset take a setting');
  assert.deepEqual(bashOffers(['dirs', 'set', 'label'], ''), [], 'the value is free text');
  assert.deepEqual(bashOffers(['config'], ''), ['show', 'get', 'set', 'unset', 'edit', 'path']);
  assert.ok(bashOffers(['config', 'set'], 'pause').includes('pauseAfterMinutes'));
  assert.deepEqual(bashOffers(['config', 'edit'], ''), [], 'only get, set and unset take a key');
  assert.deepEqual(bashOffers(['schedules', 'rm'], ''), ['Sc1aBcDe']);
  assert.deepEqual(bashOffers(['schedules', '--dry-run', 'pause'], ''), ['Sc1aBcDe']);
  assert.deepEqual(bashOffers(['tasks'], '--st'), ['--status']);
  assert.deepEqual(bashOffers(['comment', 'Ab3dEf9x'], ''), [], 'the text after the task completes to nothing');
  assert.deepEqual(bashOffers(['help'], 'sched'), ['schedule', 'schedules']);
  assert.deepEqual(bashOffers(['completion'], 'z'), ['zsh']);
});

function completeContext(backend: ReturnType<typeof fakeBackend>): (dryRun: boolean) => LinkingContext {
  return () => ({ config: CONFIG, backend, dryRun: false, taskLink: linkTo, print: () => undefined });
}

test('__complete prints id and title per line, and nothing on any failure', async () => {
  const backend = fakeBackend([task({ id: 'Ab3dEf9x', title: 'Fix\tthe\nthing' })]);
  backend.schedules = [schedule({ id: 'Sc1aBcDe', title: 'Sweep' })];
  const out: string[] = [];
  const go = (argv: string[], options: Parameters<typeof runBoard>[1] = {}) =>
    runBoard(argv, { env: {}, context: completeContext(backend), writeOut: (text) => out.push(text), ...options });
  await go(['__complete', 'tasks']);
  await go(['__complete', 'schedules']);
  assert.deepEqual(out, ['Ab3dEf9x\tFix the thing\n', 'Sc1aBcDe\tSweep\n']);
  out.length = 0;
  await go(['__complete', 'tasks'], { env: { AGENT_BOARD_TASK: 'Zt0Test1' } });
  await go(['__complete', 'nothing']);
  await go(['__complete']);
  backend.listTasks = async () => {
    throw new Error('no network');
  };
  await go(['__complete', 'tasks']);
  await go(['__complete', 'tasks'], {
    context: () => {
      throw new Error('no config');
    },
  });
  assert.deepEqual(out, []);
});

test('__complete gives up after about two seconds', async () => {
  const backend = fakeBackend([]);
  backend.listTasks = () => new Promise(() => undefined);
  const out: string[] = [];
  const started = Date.now();
  await runBoard(['__complete', 'tasks'], {
    env: {},
    context: completeContext(backend),
    writeOut: (text) => out.push(text),
  });
  const took = Date.now() - started;
  assert.deepEqual(out, []);
  assert.ok(took >= 1900 && took < 4000, `took ${took} ms`);
});

test('board __complete exits 0 and prints nothing with an empty config dir', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-completion-test-'));
  try {
    const bin = fileURLToPath(new URL('../../bin/board', import.meta.url));
    const result = await new Promise<{ code: number; stdout: string }>((resolve) => {
      const child = execFile(
        bin,
        ['__complete', 'tasks'],
        { env: { ...process.env, AGENT_BOARD_CONFIG_DIR: dir, AGENT_BOARD_TASK: '' } },
        (error, stdout) =>
          resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, stdout }),
      );
      child.stdin?.end();
    });
    assert.deepEqual(result, { code: 0, stdout: '' });
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('board completion rejects an unknown shell', async () => {
  await assert.rejects(
    runBoard(['completion', 'powershell'], { env: {} }),
    /'powershell' is invalid for argument 'shell'/,
  );
});

test('bash completes after a task link and after 09:30, which COMP_WORDS splits at the colon', () => {
  assert.deepEqual(bashOffers(['move', 'https://board.example/t/Ab3dEf9x'], 'n'), ['needs-me']);
  assert.deepEqual(bashOffers(['delay', 'Ab3dEf9x', '--at', '09:30'], '--n'), ['--now']);
  assert.deepEqual(bashOffers(['delay', 'Ab3dEf9x', '--at'], '09:'), [], 'a time is free text: nothing completes');
});

test('bash offers no task ids after a flag that takes free text, and completes file names with spaces', () => {
  assert.deepEqual(bashOffers(['delay', 'Ab3dEf9x', '--at'], ''), []);
  assert.deepEqual(bashOffers(['add', '--title'], ''), []);
  const dir = mkdtempSync(join(tmpdir(), 'board-completion-test-'));
  try {
    writeFileSync(join(dir, 'my token'), 'x');
    writeFileSync(join(dir, 'other'), 'x');
    assert.deepEqual(bashOffers(['init', '--token-file'], 'my', dir), ['my token']);
    assert.deepEqual(bashOffers(['comment', 'Ab3dEf9x', '--file'], 'oth', dir), ['other']);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// Sources the zsh script with stand-ins for the completion functions, and returns what each call asked for.
function zshOffers(line: string[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'board-completion-test-'));
  try {
    writeFileSync(join(dir, 'board.zsh'), script('zsh'));
    const words = line.map((word) => `'${word}'`).join(' ');
    const program = `
board() { if [[ $1 == __complete && $2 == tasks ]]; then printf 'Ab3dEf9x\\tFirst: one\\nZk7mNp2q\\tSecond\\n'; elif [[ $2 == schedules ]]; then printf 'Sc1aBcDe\\tSweep\\n'; fi }
_describe() { print -l -- "describe $2"; local name=\${@: -1}; print -l -- "\${(P@)name}" }
compadd() { shift; print -l -- "$@" }
_files() { print files }
compdef() { :; }
source ${join(dir, 'board.zsh')}
words=(board ${words}); CURRENT=$#words
_board`;
    const result = spawnSync('zsh', ['-c', program], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.split('\n').filter((entry) => entry !== '');
  } finally {
    rmSync(dir, { recursive: true });
  }
}

test('the zsh script completes ids, statuses, schedule actions and files', (context) => {
  if (!requireShell('zsh', context)) return;
  assert.deepEqual(zshOffers(['show', '']), ['describe ids', 'Ab3dEf9x:First: one', 'Zk7mNp2q:Second']);
  assert.deepEqual(zshOffers(['move', 'Ab3dEf9x', '']), ['backlog', 'todo', 'running', 'waiting', 'needs-me', 'done']);
  assert.deepEqual(zshOffers(['schedules', '']), ['pause', 'resume', 'rm', 'edit']);
  assert.deepEqual(zshOffers(['dirs', '']), ['list', 'add', 'rm', 'set', 'unset']);
  assert.deepEqual(zshOffers(['dirs', 'set', '']), ['label', 'repo', 'default', 'lane', 'ciIgnore']);
  assert.deepEqual(zshOffers(['dirs', 'add', '']), []);
  assert.equal(zshOffers(['schedules', 'rm', ''])[0], 'describe ids');
  assert.deepEqual(zshOffers(['schedules', 'stop', '']), [], 'the id of an unknown action is not offered');
  assert.deepEqual(zshOffers(['tasks', '--status', '']), ['backlog', 'todo', 'running', 'waiting', 'needs-me', 'done']);
  assert.deepEqual(zshOffers(['init', '--token-file', '']), ['files']);
  assert.deepEqual(zshOffers(['delay', 'Ab3dEf9x', '--at', '']), []);
  assert.ok(zshOffers(['tasks', '--']).includes('--status'));
});

// Loads the fish script with a stub `board` and returns what `complete -C` offers for the line.
function fishOffers(line: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'board-completion-test-'));
  try {
    writeFileSync(join(dir, 'board.fish'), script('fish'));
    const functions = spawnSync('sh', ['-c', 'd=$(dirname "$(command -v fish)"); echo "$d/../share/fish/functions"'], {
      encoding: 'utf8',
    }).stdout.trim();
    const program = `
set fish_function_path $fish_function_path ${functions}
function board
  test "$argv[1]" = __complete; or return
  if test "$argv[2]" = tasks
    printf 'Ab3dEf9x\\tFirst\\nZk7mNp2q\\tSecond\\n'
  else
    printf 'Sc1aBcDe\\tSweep\\n'
  end
end
source ${join(dir, 'board.fish')}
complete -C '${line}'`;
    const result = spawnSync('fish', ['-c', program], { encoding: 'utf8', cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.split('\n').filter((entry) => entry !== '');
  } finally {
    rmSync(dir, { recursive: true });
  }
}

test('the fish script completes ids, statuses, schedule actions and files, and nothing after a free-text flag', (context) => {
  if (!requireShell('fish', context)) return;
  assert.deepEqual(fishOffers('board show '), ['Ab3dEf9x\tFirst', 'Zk7mNp2q\tSecond']);
  assert.deepEqual(fishOffers('board move Ab3dEf9x ').sort(), [
    'backlog',
    'done',
    'needs-me',
    'running',
    'todo',
    'waiting',
  ]);
  assert.deepEqual(fishOffers('board schedules '), ['edit', 'pause', 'resume', 'rm']);
  assert.deepEqual(fishOffers('board dirs '), ['add', 'list', 'rm', 'set', 'unset']);
  assert.deepEqual(fishOffers('board dirs unset '), ['ciIgnore', 'default', 'label', 'lane', 'repo']);
  assert.deepEqual(fishOffers('board dirs add '), []);
  assert.deepEqual(fishOffers('board schedules rm '), ['Sc1aBcDe\tSweep']);
  assert.deepEqual(fishOffers('board delay Ab3dEf9x --at '), []);
  assert.deepEqual(fishOffers('board add --title '), []);
  assert.deepEqual(fishOffers('board add --parent '), ['Ab3dEf9x\tFirst', 'Zk7mNp2q\tSecond']);
  assert.deepEqual(fishOffers('board init --token-file board.fi'), ['board.fish']);
  assert.deepEqual(fishOffers('board comment Ab3dEf9x '), []);
});
