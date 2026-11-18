// Builds the binary for this host and runs it the way a worker machine would: outside the checkout, with no node on PATH,
// a temporary home and config dir, and a local fake of the machine API. These are the paths where Bun and Node could differ.
// Usage: node scripts/binary-smoke.mts   (needs bun on PATH; BOARD_BINARY=<file> tests a binary that is built already)
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  API_VERSION,
  LEGACY_CONTRACT,
  MIN_CLIENT,
  SERVER_FEATURES,
  dedupeKeyIndex,
  headIndex,
  deriveKeys,
  encodeDataKey,
  generateDataKey,
  noteBinding,
  open,
  seal,
} from '@agent-board/shared';
import { DATA_KEY, ENV_FILE, KEYS, OWNER, wireTask } from '../src/__tests__/helpers/fakes.mts';

const cliDir = fileURLToPath(new URL('..', import.meta.url));
const version = (JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8')) as { version: string }).version;
const target = `${process.platform}-${process.arch}`;
const onMac = process.platform === 'darwin';

if (!['linux-x64', 'linux-arm64', 'darwin-arm64'].includes(target)) throw new Error(`no binary is built for ${target}`);
const dist = mkdtempSync(join(tmpdir(), 'board-binary-dist-'));
// BOARD_BINARY names a binary that is already built (the release workflow runs the very file it publishes).
const prebuilt = process.env['BOARD_BINARY'];
if (prebuilt === undefined)
  execFileSync('sh', [join(cliDir, 'build.sh'), target], {
    cwd: cliDir,
    env: { ...process.env, DIST_DIR: dist },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

const root = mkdtempSync(join(tmpdir(), 'board-binary-smoke-'));
const outside = mkdtempSync('/var/tmp/board-binary-smoke-');
// The real path: the binary reports itself with /private/var, which os.tmpdir() (/var/folders) hides on macOS.
const binary = join(realpathSync(root), 'board');
copyFileSync(prebuilt ?? join(dist, `board-${target}`), binary);
chmodSync(binary, 0o755);

// How a dry-run tick says it would start the worker: a transient unit on Linux, a detached process on macOS.
const workerStart = onMac
  ? new RegExp(`DRY spawn detached ${binary} internal worker Ab3dEf9x`)
  : new RegExp(`DRY systemd-run .* -- ${binary} internal worker Ab3dEf9x`);

const toolBin = join(root, 'bin');
mkdirSync(toolBin);
const systemdRuns = join(root, 'systemd-run.log');
// Read-only systemctl and a systemd-run that would start something: the dry run must never call the latter.
writeFileSync(
  join(toolBin, 'systemctl'),
  '#!/bin/sh\ncase "$*" in *is-active*) echo inactive; exit 3 ;; esac\nexit 0\n',
  { mode: 0o755 },
);
const PR_URL = 'https://github.com/o/r/pull/1';
writeFileSync(join(toolBin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
writeFileSync(join(toolBin, 'systemd-run'), `#!/bin/sh\necho "$*" >> '${systemdRuns}'\n`, { mode: 0o755 });
const path = `${toolBin}:/usr/bin:/bin`;
for (const dir of path.split(':'))
  assert.ok(
    !existsSync(join(dir, 'node')) && !existsSync(join(dir, 'bun')),
    `node or bun is on the smoke test PATH (${dir})`,
  );

type Mode = 'normal' | 'redirect';
let mode: Mode = 'normal';
// How long list-tasks takes to answer: long enough to replace the binary while a tick waits for it.
let listDelayMs = 0;
const requests: { command: string; body: string }[] = [];
// The board no longer sends a link, but a hostile one still says what a link of its own would be.
const todo = {
  ...(await wireTask({ id: 'Ab3dEf9x', title: 'Fix the thing', status: 'todo' })),
  url: 'https://evil.example/t/Ab3dEf9x',
};
// A task sealed with another data key: this machine can open its title but not its prompt, or neither.
const otherKeys = await deriveKeys(generateDataKey(), OWNER);
const foreign = {
  ...(await wireTask({ id: 'Un0pen01', title: 'Foreign', status: 'todo' })),
  input: await seal(otherKeys, 'input', '', 'a prompt this machine cannot open'),
};
// What the fake board answers; a check changes it and puts it back.
const fake = {
  api: { version: API_VERSION, minClient: MIN_CLIENT },
  features: [...SERVER_FEATURES] as string[],
  keyId: KEYS.keyId as string | null,
  tasks: [todo] as unknown[],
  // What get-task answers; a worker's run changes it to the task it runs.
  current: todo as unknown,
};
async function withBoard(patch: Partial<typeof fake>, run: () => Promise<void>): Promise<void> {
  const before = { ...fake };
  Object.assign(fake, patch);
  try {
    await run();
  } finally {
    Object.assign(fake, before);
  }
}
const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  let body = '';
  request.on('data', (chunk: Buffer) => (body += String(chunk)));
  request.on('end', () => {
    const command = request.url?.split('/').pop() ?? '';
    requests.push({ command, body });
    if (mode === 'redirect') {
      response.writeHead(302, { location: '/elsewhere' });
      return response.end();
    }
    const results: Record<string, unknown> = {
      version: { contract: LEGACY_CONTRACT, owner: OWNER, keyId: fake.keyId, api: fake.api, features: fake.features },
      'list-tasks': fake.tasks,
      'get-task': fake.current,
      fail: { applied: true, task: fake.current },
      pause: fake.current,
      'read-notes': [],
      'update-task': todo,
      'add-task': { task: todo, created: true },
      'claim-task': { ...todo, status: 'running', machine: 'smoke' },
    };
    const reply = (): void => void response.end(JSON.stringify({ result: results[command] ?? null }));
    if (command === 'list-tasks' && listDelayMs > 0) setTimeout(reply, listDelayMs);
    else reply();
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// The note bodies the fake server holds: sealed envelopes that only the test key opens.
async function storedNotes(): Promise<string[]> {
  const notes: string[] = [];
  for (const request of requests.filter((entry) => entry.command === 'add-note')) {
    const { id, body } = JSON.parse(request.body) as { id: string; body: { body: string } };
    assert.ok(body.body.startsWith('abe1.'), 'a note must reach the server sealed');
    // A note is bound to its task, author and kind.
    const binding = noteBinding('note.body', id, 'agent', 'comment');
    notes.push(await open(KEYS, binding.field, binding.context, body.body));
  }
  return notes;
}

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function board(args: string[], configDir: string, env: Record<string, string> = {}): Promise<Result> {
  return new Promise((resolve) => {
    const child = execFile(
      binary,
      args,
      {
        cwd: root,
        env: {
          PATH: path,
          // As in a shell: without it os.tmpdir() is /tmp, and the temp-directory check could not see the binary on macOS.
          TMPDIR: tmpdir(),
          HOME: root,
          XDG_CONFIG_HOME: join(root, 'xdg'),
          AGENT_BOARD_CONFIG_DIR: configDir,
          XDG_RUNTIME_DIR: root,
          ...env,
        },
        timeout: 30_000,
      },
      (error, stdout, stderr) =>
        resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, stdout, stderr }),
    );
    child.stdin?.end();
  });
}

let configCount = 0;
function config(
  options: {
    webUrl?: string;
    envMode?: number;
    config?: boolean;
    dataKey?: Uint8Array;
    noKey?: boolean;
    intake?: boolean;
  } = {},
): string {
  const dir = join(root, `cfg${(configCount += 1)}`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'web.json'), JSON.stringify({ url: options.webUrl ?? url }));
  const env = options.noKey
    ? 'AGENT_BOARD_TOKEN=abm_smoketoken\n'
    : options.dataKey
      ? `AGENT_BOARD_TOKEN=abm_smoketoken\nAGENT_BOARD_DATA_KEY=${encodeDataKey(options.dataKey)}\n`
      : ENV_FILE;
  writeFileSync(join(dir, 'env'), env, { mode: options.envMode ?? 0o600 });
  chmodSync(join(dir, 'env'), options.envMode ?? 0o600);
  if (options.config)
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ machine: 'smoke', ...(options.intake ? { intake: {} } : {}) }),
    );
  return dir;
}

let failures = 0;
async function check(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(
      `FAIL ${name}\n     ${error instanceof Error ? error.message.replaceAll('\n', '\n     ') : String(error)}`,
    );
  }
}

const empty = join(root, 'empty');
mkdirSync(empty);

await check('--version shows the injected version', async () => {
  const result = await board(['--version'], empty);
  assert.deepEqual([result.code, result.stdout], [0, `board ${version} (api ${API_VERSION})\n`]);
});
await check('help and help schedule', async () => {
  const help = await board(['help'], empty);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Tasks:[\s\S]*Scheduling:[\s\S]*Setup:/);
  const schedule = await board(['help', 'schedule'], empty);
  assert.match(schedule.stdout, /Usage: board schedule[\s\S]*Examples:/);
});
await check('completion bash', async () => {
  const result = await board(['completion', 'bash'], empty);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^# bash completion for board/);
});
await check('agents add example:reviewer writes a YAML file the binary reads back', async () => {
  const dir = config({ config: true });
  const added = await board(['agents', 'add', 'example:reviewer', '--yes'], dir);
  assert.equal(added.code, 0, added.stderr);
  assert.match(added.stdout, /allowedTools \(\d+\):[\s\S]*disallowedTools/);
  assert.equal(statSync(join(dir, 'agents', 'reviewer.yaml')).mode & 0o777, 0o600);
  const shown = await board(['agents', 'show', 'reviewer', '--json'], dir);
  assert.equal(shown.code, 0, shown.stderr);
  assert.equal((JSON.parse(shown.stdout) as { source?: string }).source, 'example:reviewer');
  const refused = await board(['agents', 'add', 'http://example.com/a.yaml', '--yes'], dir);
  assert.match(refused.stderr, /only https/);
});
await check('tasks works with only web.json and env', async () => {
  const result = await board(['tasks'], config());
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /todo \(1\)\n {2}Ab3dEf9x {2}normal {2}Fix the thing/);
});
await check('--dry-run comment writes nothing', async () => {
  requests.length = 0;
  const result = await board(['--dry-run', 'comment', 'Ab3dEf9x', 'hello'], config());
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /DRY add-note Ab3dEf9x hello/);
  assert.ok(!requests.some((request) => request.command === 'add-note'));
});
await check('comment --file reads a file in /tmp, and refuses a link to a file outside it', async () => {
  const dir = mkdtempSync('/tmp/board-binary-smoke-note-');
  try {
    const note = join(dir, 'note.md');
    writeFileSync(note, 'from a file\n');
    requests.length = 0;
    const ok = await board(['comment', 'Ab3dEf9x', '--file', note], config({ webUrl: `${url}/board` }));
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual(await storedNotes(), ['from a file']);
    assert.equal(
      ok.stdout.trim(),
      `commented on Ab3dEf9x  ${url}/board/t/Ab3dEf9x`,
      'the link is built from web.json, not sent by the board',
    );
    const secret = join(outside, 'secret');
    writeFileSync(secret, 'TOKEN=1');
    const link = join(dir, 'link.md');
    symlinkSync(secret, link);
    requests.length = 0;
    const refused = await board(['comment', 'Ab3dEf9x', '--file', link], config());
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /cannot read the note file/);
    const viaDir = join(dir, 'linkdir');
    symlinkSync(outside, viaDir);
    const refusedDir = await board(['comment', 'Ab3dEf9x', '--file', join(viaDir, 'secret')], config());
    assert.match(refusedDir.stderr, /must be inside \/tmp\//);
    assert.ok(!requests.some((request) => request.command === 'add-note'));
  } finally {
    rmSync(dir, { recursive: true });
  }
});
await check('an env file with mode 644 is refused', async () => {
  const result = await board(['tasks'], config({ envMode: 0o644 }));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /must be mode 600 or 400, is 644/);
});
await check('an http URL that is not localhost is refused', async () => {
  const result = await board(['tasks'], config({ webUrl: 'http://board.example.com' }));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /https unless it is localhost/);
});
await check('a server that answers with a redirect fails the call', async () => {
  mode = 'redirect';
  try {
    const result = await board(['tasks'], config());
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /cannot reach/);
  } finally {
    mode = 'normal';
  }
});
await check('setup --print points the units (launch agents on macOS) at this binary', async () => {
  const result = await board(['setup', '--print'], empty);
  assert.equal(result.code, 0, result.stderr);
  if (onMac) {
    assert.match(result.stdout, /<string>\/usr\/bin\/lockf<\/string>/);
    assert.ok(
      result.stdout.includes(
        `<string>${binary}</string>\n\t\t<string>internal</string>\n\t\t<string>dispatch</string>`,
      ),
    );
    return;
  }
  assert.match(
    result.stdout,
    new RegExp(`ExecStart=\\S*flock -n -E 75 %t/agent-board-dispatch.lock ${binary} internal dispatch\\n`),
  );
});
await check('a data key that is not the board’s is refused, naming both key ids and never the key', async () => {
  const wrong = generateDataKey();
  const result = await board(['tasks'], config({ dataKey: wrong }));
  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /this machine holds a different data key \(id [0-9a-f]{16}\) than the board's \(id [0-9a-f]{16}\)/,
  );
  assert.ok(!result.stderr.includes(encodeDataKey(wrong)));
});
await check('a board without a data key is refused', async () => {
  await withBoard({ keyId: null }, async () => {
    const result = await board(['tasks'], config());
    assert.equal(result.code, 1);
    assert.match(result.stderr, /the board has no data key yet: set up encryption in the browser first/);
  });
});
await check('a machine without a data key in env is refused, saying where to get it', async () => {
  const result = await board(['tasks'], config({ noKey: true }));
  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /the credentials file needs AGENT_BOARD_DATA_KEY \(copy it from the board's Settings page, then run "board init"\)/,
  );
});
await check(
  'a config with the removed intake key fails doctor with the replacement and stops nothing else',
  async () => {
    const dir = config({ config: true, intake: true });
    const doctor = await board(['doctor', '--json'], dir);
    assert.equal(doctor.code, 1);
    const failed = (JSON.parse(doctor.stdout) as { name: string; level: string; message: string }[]).filter(
      (result) => result.name === 'config.json' && result.level === 'fail',
    );
    assert.match(failed[0]?.message ?? '', /the built-in intake was removed: run the github-reviews script/);
    assert.equal((await board(['tasks'], dir)).code, 0, 'the key is a warning, not a config error');
    const stub = await board(['internal', 'intake'], dir);
    assert.equal(stub.code, 0, 'a leftover timer must not fail');
    assert.match(stub.stdout, /the built-in intake was removed.*run "board setup" to delete this timer/);
  },
);
await check(
  'board schedule --key sends a blind index of the PR URL, and --version one of the head: the binary computes them as node does',
  async () => {
    requests.length = 0;
    const result = await board(
      ['schedule', '--key', PR_URL, '--version', 'abc123', '--json', '/review-pr', PR_URL, '--auto'],
      config({ config: true }),
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      id: 'Ab3dEf9x',
      url: `${url}/t/Ab3dEf9x`,
      result: 'created',
      status: 'todo',
    });
    const added = requests.find((request) => request.command === 'add-task');
    assert.ok(added, 'schedule sent no add-task');
    const draft = (JSON.parse(added.body) as { body: { dedupeKey: string; head: string } }).body;
    assert.equal(draft.dedupeKey, await dedupeKeyIndex(KEYS, PR_URL));
    assert.equal(draft.head, await headIndex(KEYS, 'abc123'));
    // No field of the draft carries the key in clear; dedupeKey and head are blind indexes (checked above).
    assert.ok(
      !Object.values(draft as Record<string, unknown>).some((value) => value === PR_URL),
      'the key must not reach the server',
    );
  },
);
await check('a board that no longer serves this binary says how to update it', async () => {
  await withBoard({ api: { version: API_VERSION + 1, minClient: API_VERSION + 1 } }, async () => {
    const result = await board(['tasks'], config());
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /this CLI is older than the board server: .*run "board self-update"/);
  });
});
await check('a board without a feature refuses that command alone', async () => {
  await withBoard({ features: ['events'] }, async () => {
    const attached = await board(['attach', 'Ab3dEf9x'], config());
    assert.notEqual(attached.code, 0);
    assert.match(
      attached.stderr,
      /the board server does not support attaching to a task session yet; update the board server/,
    );
    assert.equal((await board(['tasks'], config())).code, 0);
  });
});
await check('doctor compares this machine’s key with the board’s', async () => {
  const good = await board(['doctor'], config({ config: true }));
  assert.match(good.stdout, /✓ board key: the board's data key is id [0-9a-f]{16}, and this machine holds it/);
  assert.ok(!good.stdout.includes(encodeDataKey(DATA_KEY)));
  const bad = await board(['doctor', '--json'], config({ dataKey: generateDataKey() }));
  assert.equal(bad.code, 1);
  const checks = JSON.parse(bad.stdout) as { name: string; level: string }[];
  assert.equal(checks.find((entry) => entry.name === 'board key')?.level, 'fail');
});
await check('a task this machine cannot open is shown as such, and the dispatcher skips it', async () => {
  await withBoard({ tasks: [foreign, todo] }, async () => {
    const listed = await board(['tasks'], config());
    assert.match(listed.stdout, /Un0pen01 {2}normal {2}Foreign {2}\(cannot decrypt: input\)/);
    assert.match(listed.stdout, /Ab3dEf9x {2}normal {2}Fix the thing\n/);
    const json = JSON.parse((await board(['tasks', '--json'], config())).stdout) as {
      id: string;
      input: string | null;
    }[];
    assert.equal(json.find((entry) => entry.id === 'Un0pen01')?.input, null);
  });
  await withBoard({ tasks: [foreign] }, async () => {
    requests.length = 0;
    const result = await board(['internal', 'dispatch', '--dry-run'], config({ config: true }));
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /SKIP Un0pen01 cannot decrypt its input/);
    assert.match(result.stdout, /TICK started=0/);
    assert.ok(!result.stdout.includes('DRY claim-task'));
  });
});
// A prompt that starts with dashes, is large and has multi-byte characters: it must reach claude on stdin, whole, and never in argv.
const BIG_PROMPT = `--dangerously-skip-permissions --mcp-config x\n${'héllo wörld 日本語 '.repeat(8000)}`.trim();

function fakeClaude(name: string, script: string): string {
  const dir = join(root, name);
  mkdirSync(dir);
  writeFileSync(join(dir, 'claude'), script, { mode: 0o755 });
  return `${dir}:${path}`;
}

async function runWorkerWith(claudePath: string, prompt: string): Promise<{ result: Result; seen: string }> {
  const running = await wireTask({
    id: 'Wk0Run01',
    title: 'Run it',
    input: prompt,
    status: 'running',
    machine: 'smoke',
  });
  const dir = config({ config: true });
  const seen = join(root, `claude-seen-${configCount}`);
  mkdirSync(seen);
  const result = await withBoardAsync({ current: running }, () =>
    board(['internal', 'worker', 'Wk0Run01'], dir, {
      PATH: claudePath,
      SEEN: seen,
      AGENT_BOARD_STATE_DIR: join(root, `state-${configCount}`),
    }),
  );
  return { result, seen };
}

async function withBoardAsync<T>(patch: Partial<typeof fake>, run: () => Promise<T>): Promise<T> {
  const before = { ...fake };
  Object.assign(fake, patch);
  try {
    return await run();
  } finally {
    Object.assign(fake, before);
  }
}

const args0 = (seen: string): string => readFileSync(join(seen, 'args'), 'utf8');
await check('a worker hands claude a large prompt on stdin, whole, and not in its arguments', async () => {
  const claudePath = fakeClaude(
    'claude-reads',
    // stream-json input: the prompt is the first line, a user message; stdin stays open until the run's result line.
    '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$SEEN/args"\nIFS= read -r line\nprintf \'%s\' "$line" > "$SEEN/stdin"\necho \'{"type":"result","subtype":"success","result":"ok"}\'\ncat > /dev/null\n',
  );
  const { result, seen } = await runWorkerWith(claudePath, BIG_PROMPT);
  assert.equal(result.code, 0, result.stderr);
  const line: unknown = JSON.parse(readFileSync(join(seen, 'stdin'), 'utf8'));
  const received =
    typeof line === 'object' && line !== null && 'message' in line
      ? (line.message as { content?: unknown }).content
      : undefined;
  assert.ok(
    received === BIG_PROMPT,
    `claude received ${typeof received === 'string' ? received.length : 'no'} characters, expected ${BIG_PROMPT.length}`,
  );
  assert.match(args0(seen), /--input-format\nstream-json\n/);
  const args = readFileSync(join(seen, 'args'), 'utf8');
  assert.ok(
    !args.includes('héllo') && !args.includes('--dangerously-skip-permissions\n--mcp-config'),
    'the prompt reached argv',
  );
  assert.match(args, /--session-id=[0-9a-f-]{36}\n/);
  // The hook claude is given is this binary again, whatever claude does with stdin.
  assert.ok(args.includes(`${binary}' 'internal' 'hook'`), 'the hook command does not run this binary');
});
await check('a claude that exits without reading its stdin does not take the worker down', async () => {
  const claudePath = fakeClaude('claude-deaf', '#!/bin/sh\nexit 0\n');
  const { result } = await runWorkerWith(claudePath, BIG_PROMPT);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(!/unexpected error|EPIPE/.test(result.stderr), result.stderr);
});
await check('SIGUSR2 makes a worker interrupt claude and report its task paused, under Bun too', async () => {
  const claudePath = fakeClaude(
    'claude-shutdown',
    [
      '#!/bin/sh',
      'IFS= read -r prompt',
      'kill -USR2 "$PPID"',
      'while IFS= read -r line; do',
      '  case "$line" in',
      '    *control_request*) echo \'{"type":"result","subtype":"error_during_execution"}\';;',
      '  esac',
      'done',
      '',
    ].join('\n'),
  );
  const before = requests.length;
  const started = Date.now();
  const { result } = await runWorkerWith(claudePath, 'work');
  assert.equal(result.code, 0, result.stderr);
  assert.ok(Date.now() - started < 10_000, 'the worker waited for the grace instead of the end of the turn');
  const sent = requests.slice(before).map((entry) => entry.command);
  assert.ok(sent.includes('pause'), `no pause report in ${sent.join(', ')}`);
  assert.ok(!sent.includes('fail'), 'the shutdown was reported as a failure');
});
await check('setup writes the binary that runs, not whatever ~/.local/bin/board resolves to', async () => {
  const installDir = join(root, 'installed');
  mkdirSync(installDir);
  const other = join(root, 'board-other');
  copyFileSync(binary, other);
  chmodSync(other, 0o755);
  symlinkSync(other, join(installDir, 'board'));
  const result = await board(['setup', '--print'], empty, { BOARD_INSTALL_DIR: installDir });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(
    result.stdout.includes(onMac ? `<string>${binary}</string>` : ` ${binary} internal dispatch\n`),
    result.stdout,
  );
  assert.ok(!result.stdout.includes(other), 'the units must not run another binary');
});
await check('setup refuses a binary in the temp directory without --force', async () => {
  const refused = await board(['setup'], empty);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /in the temp directory/);
  const forced = await board(['setup', '--force'], empty);
  assert.equal(forced.code, 0, forced.stderr);
  if (onMac)
    assert.ok(
      readFileSync(join(root, 'Library', 'LaunchAgents', 'de.codeplant.agent-board.dispatch.plist'), 'utf8').includes(
        `<string>${binary}</string>`,
      ),
    );
  else
    assert.match(
      readFileSync(join(root, 'xdg', 'systemd', 'user', 'agent-board-dispatch.service'), 'utf8'),
      new RegExp(`${binary} internal dispatch`),
    );
});
await check('a closed pipe keeps the exit code: doctor | head is 1, help | head is 0, nothing on stderr', async () => {
  const through = (args: string): Promise<string> =>
    new Promise((resolve) => {
      execFile(
        'bash',
        ['-c', `"$BOARD" ${args} 2>"$ERR" | head -c0; echo "\${PIPESTATUS[0]}:$(cat "$ERR")"`],
        {
          env: { PATH: path, HOME: root, AGENT_BOARD_CONFIG_DIR: empty, BOARD: binary, ERR: join(root, 'pipe-stderr') },
        },
        (_error, stdout) => resolve(stdout.trim()),
      );
    });
  assert.equal(await through('doctor'), '1:');
  assert.equal(await through('help'), '0:');
});
await check('a loopback board is never sent through HTTP_PROXY', async () => {
  const proxied: string[] = [];
  const proxy = createServer((request, response) => {
    proxied.push(`${request.method} ${request.url} ${request.headers.authorization ?? ''}`);
    response.writeHead(502).end();
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    const result = await board(['tasks'], config(), {
      HTTP_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      ALL_PROXY: proxyUrl,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Fix the thing/);
    assert.deepEqual(proxied, []);
  } finally {
    proxy.close();
  }
});
await check('a tick that waits while the binary is replaced still plans a worker with the real path', async () => {
  // Bun reads process.execPath lazily, and after the rename it would say "<path> (deleted)".
  listDelayMs = 1500;
  try {
    const running = new Promise<Result>((resolve) => {
      const child = execFile(
        binary,
        ['internal', 'dispatch', '--dry-run'],
        {
          cwd: root,
          env: { PATH: path, HOME: root, AGENT_BOARD_CONFIG_DIR: config({ config: true }), XDG_RUNTIME_DIR: root },
          timeout: 30_000,
        },
        (error, stdout, stderr) =>
          resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, stdout, stderr }),
      );
      child.stdin?.end();
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    const replacement = `${binary}.new`;
    copyFileSync(binary, replacement);
    chmodSync(replacement, 0o755);
    renameSync(replacement, binary);
    const result = await running;
    assert.equal(result.code, 0, result.stderr);
    assert.ok(!result.stdout.includes('(deleted)'), result.stdout);
    assert.match(result.stdout, workerStart);
  } finally {
    listDelayMs = 0;
  }
});
// `init` with one secret on a real pipe (what a shell makes of `printf … |`) and the other in a file, under Bun.
async function initThroughPipe(piped: 'token' | 'key', dir: string): Promise<Result> {
  const file = join(root, `secret-${piped}`);
  writeFileSync(file, piped === 'token' ? `${encodeDataKey(DATA_KEY)}\n` : 'abm_piped\n', { mode: 0o600 });
  const flags =
    piped === 'token'
      ? '--token-file /dev/stdin --data-key-file "$FILE"'
      : '--data-key-file /dev/stdin --token-file "$FILE"';
  return new Promise<Result>((resolve) => {
    execFile(
      'sh',
      ['-c', `printf %s "$PIPED" | "$BOARD" init --url ${url} ${flags} --machine smoke`],
      {
        cwd: root,
        env: {
          PATH: path,
          HOME: root,
          AGENT_BOARD_CONFIG_DIR: dir,
          PIPED: piped === 'token' ? 'abm_piped' : encodeDataKey(DATA_KEY),
          FILE: file,
          BOARD: binary,
        },
        timeout: 30_000,
      },
      (error, stdout, stderr) =>
        resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, stdout, stderr }),
    );
  });
}

await check(
  'init reads a secret from a pipe (--token-file or --data-key-file /dev/stdin) and writes env with mode 600',
  async () => {
    for (const piped of ['token', 'key'] as const) {
      const dir = join(root, `init-cfg-${piped}`);
      const result = await initThroughPipe(piped, dir);
      assert.equal(
        readFileSync(join(dir, 'env'), 'utf8'),
        `AGENT_BOARD_TOKEN=abm_piped\nAGENT_BOARD_DATA_KEY=${encodeDataKey(DATA_KEY)}\n`,
      );
      assert.equal(statSync(join(dir, 'env')).mode & 0o777, 0o600);
      assert.match(result.stdout, /✓ board key: the board's data key is id /);
      assert.ok(!result.stdout.includes('abm_piped') && !result.stdout.includes(encodeDataKey(DATA_KEY)));
    }
  },
);
await check('a world-readable token file is refused by init', async () => {
  const file = join(root, 'wide-token');
  writeFileSync(file, 'abm_wide\n', { mode: 0o644 });
  chmodSync(file, 0o644);
  const result = await board(['init', '--url', url, '--token-file', file], join(root, 'init-cfg2'));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /token file must be mode 600 or 400, is 644/);
});
await check('the prompts library is bundled although it is loaded only when init asks', async () => {
  // Loaded by a dynamic import, which has to end up inside the executable; a string that only clack carries.
  assert.ok(readFileSync(binary).includes('Press Ctrl+C to cancel') || readFileSync(binary).includes('withGuide'));
});
await check('internal hook creates the heartbeat file', async () => {
  const runDir = mkdtempSync(join(root, 'run-'));
  const result = await board(['internal', 'hook', runDir, 'Ab3dEf9x'], empty);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(readdirSync(runDir), ['Ab3dEf9x.alive']);
});
await check('internal dispatch --dry-run plans a start with this binary and starts nothing', async () => {
  requests.length = 0;
  const result = await board(['internal', 'dispatch', '--dry-run'], config({ config: true }));
  assert.equal(result.code, 0, result.stderr);
  console.log(result.stdout.trimEnd().replace(/^/gm, '       | '));
  assert.match(result.stdout, /DRY claim-task Ab3dEf9x --machine smoke/);
  assert.match(result.stdout, workerStart);
  assert.match(result.stdout, /STARTED Ab3dEf9x/);
  assert.ok(!existsSync(systemdRuns), 'systemd-run was called');
  assert.ok(
    !requests.some((request) => ['claim-task', 'add-note', 'update-task'].includes(request.command)),
    'a write reached the server',
  );
});

server.close();
rmSync(root, { recursive: true });
rmSync(outside, { recursive: true });
rmSync(dist, { recursive: true });
if (failures > 0) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('binary smoke test passed');
