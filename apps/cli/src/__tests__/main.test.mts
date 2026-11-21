import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { encodeDataKey } from '@agent-board/shared';
import { DATA_KEY, ENV_FILE, VERSION_ANSWER, wireTask } from './helpers/fakes.mts';
import { keepLoopbackOffProxy } from '../cli.mts';
import { fakeBoard } from './helpers/fake-board.mts';

const BIN = fileURLToPath(new URL('../../bin/', import.meta.url));
const sealedTask = await wireTask({ id: 'Ab3dEf9x', title: 'Fix the thing' });

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function run(bin: string, args: string[], configDir: string, env: Record<string, string> = {}): Promise<Result> {
  return new Promise((resolve) => {
    const child = execFile(
      join(BIN, bin),
      args,
      { env: { ...process.env, AGENT_BOARD_CONFIG_DIR: configDir, AGENT_BOARD_TASK: '', ...env }, timeout: 20_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
        resolve({ code, stdout, stderr });
      },
    );
    child.stdin?.end();
  });
}

function emptyConfigDir(): string {
  return mkdtempSync(join(tmpdir(), 'board-main-test-'));
}

test('help and version need no config file', async () => {
  const dir = emptyConfigDir();
  try {
    const overview = await run('board', [], dir);
    assert.equal(overview.code, 0);
    assert.match(overview.stdout, /Tasks:[\s\S]*Scheduling:[\s\S]*Setup:/);
    for (const args of [['help'], ['-h'], ['--help']]) {
      const result = await run('board', args, dir);
      assert.equal(result.code, 0, args.join(' '));
      assert.equal(result.stdout, overview.stdout);
    }
    for (const args of [
      ['help', 'comment'],
      ['comment', '--help'],
      ['schedule', '-h'],
    ]) {
      const result = await run('board', args, dir);
      assert.equal(result.code, 0, args.join(' '));
      assert.match(result.stdout, /Usage: board /);
    }
    for (const flag of ['--version', '-V']) {
      const result = await run('board', [flag], dir);
      assert.equal(result.code, 0);
      assert.match(result.stdout, /^board \d+\.\d+\.\d+-dev \(api \d+\)\n$/);
    }
    for (const result of [overview, await run('board', ['--version'], dir)])
      assert.doesNotMatch(result.stderr, /config file missing/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a usage error exits 2 with the usage of its command and a hint', async () => {
  const dir = emptyConfigDir();
  try {
    const result = await run('board', ['schedule', '--hodl', 'x'], dir);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /^board: unknown option '--hodl'\n\(Did you mean --hold\?\)\n/);
    assert.match(result.stderr, /usage: board schedule \[options\] <prompt\.\.\.>\n/);
    assert.match(result.stderr, /Run "board help schedule" for the details\.\n$/);
    assert.equal(result.stdout, '');
    assert.equal((await run('board', ['comment', 'abc'], dir)).code, 2);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('an unknown command gets the nearest match', async () => {
  const dir = emptyConfigDir();
  try {
    const result = await run('board', ['shw'], dir);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /^board: unknown command 'shw'\n\(Did you mean show\?\)\n/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('the other entry points keep the agent-board prefix', async () => {
  const dir = emptyConfigDir();
  try {
    const worker = await run('board', ['internal', 'worker', 'not/a/task'], dir);
    assert.equal(worker.code, 2);
    assert.match(worker.stderr, /^agent-board: "not\/a\/task" is not a task id\n/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// These spawn the real wrapper with an empty config dir: a broken guard must fail on the missing config, never run a tick.
test('a typo or an extra argument on an internal command is refused before its action runs', async () => {
  const dir = emptyConfigDir();
  try {
    for (const args of [
      ['internal', 'dispatch', '--dryrun'],
      ['internal', 'dispatch', 'extra'],
    ]) {
      const result = await run('board', args, dir);
      assert.equal(result.code, 2, args.join(' '));
      assert.doesNotMatch(result.stderr, /config file missing/, args.join(' '));
      assert.match(result.stderr, /^agent-board: /);
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('internal dispatch and worker are refused inside a run', async () => {
  const dir = emptyConfigDir();
  try {
    for (const args of [
      ['internal', 'dispatch'],
      ['internal', 'worker', 'Zt0Test1'],
    ]) {
      const result = await run('board', args, dir, { AGENT_BOARD_TASK: 'Zt0Test1' });
      assert.equal(result.code, 2, args.join(' '));
      assert.match(result.stderr, /not available inside a board run/);
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('the hook of a run touches its own task only, and exits 0 on bad arguments', async () => {
  const dir = emptyConfigDir();
  const runDir = mkdtempSync(join(tmpdir(), 'board-hook-test-'));
  try {
    const inRun = { AGENT_BOARD_TASK: 'Zt0Test1', AGENT_BOARD_RUN_DIR: runDir };
    const elsewhere = mkdtempSync(join(tmpdir(), 'board-hook-test-'));
    try {
      const wrongDir = await run('board', ['internal', 'hook', elsewhere, 'Zt0Test1'], dir, inRun);
      assert.equal(wrongDir.code, 0);
      assert.deepEqual(readdirSync(elsewhere), [], 'a run-dir argument other than the run own is ignored');
    } finally {
      rmSync(elsewhere, { recursive: true });
    }
    const other = await run('board', ['internal', 'hook', runDir, 'Other001'], dir, inRun);
    assert.equal(other.code, 0);
    assert.deepEqual(readdirSync(runDir), []);
    const own = await run('board', ['internal', 'hook', runDir, 'Zt0Test1'], dir, inRun);
    assert.equal(own.code, 0);
    assert.deepEqual(readdirSync(runDir), ['Zt0Test1.alive']);
    const bad = await run('board', ['internal', 'hook'], dir);
    assert.equal(bad.code, 0);
    assert.match(bad.stderr, /usage: board internal hook/);
  } finally {
    rmSync(dir, { recursive: true });
    rmSync(runDir, { recursive: true });
  }
});

test('tasks works with only web.json and env', async () => {
  const dir = emptyConfigDir();
  const server = createServer((request, response) => {
    const command = request.url?.split('/').pop();
    request.resume();
    request.on('end', () => {
      const result = command === 'version' ? VERSION_ANSWER : [sealedTask];
      response.end(JSON.stringify({ result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    writeFileSync(join(dir, 'web.json'), JSON.stringify({ url: `http://127.0.0.1:${port}` }));
    writeFileSync(join(dir, 'env'), ENV_FILE, { mode: 0o600 });
    const result = await run('board', ['tasks'], dir);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /todo \(1\)\n {2}Ab3dEf9x {2}normal {2}Fix the thing\n/);
    assert.ok(!result.stdout.includes('\x1b'));
  } finally {
    server.close();
    rmSync(dir, { recursive: true });
  }
});

// A board that answers `version` with the given API range and every list with `list`.
async function withFakeBoard(
  api: { version: number; minClient: number },
  list: unknown[],
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = emptyConfigDir();
  const server = createServer((request, response) => {
    const command = request.url?.split('/').pop();
    request.resume();
    request.on('end', () => {
      response.end(JSON.stringify({ result: command === 'version' ? { ...VERSION_ANSWER, api } : list }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    writeFileSync(join(dir, 'web.json'), JSON.stringify({ url: `http://127.0.0.1:${port}` }));
    writeFileSync(join(dir, 'env'), ENV_FILE, { mode: 0o600 });
    writeFileSync(join(dir, 'config.json'), '{}');
    await body(dir);
  } finally {
    server.close();
    rmSync(dir, { recursive: true });
  }
}

test('a dispatch tick against an older server logs one line and exits 0; a command fails clearly', async () => {
  await withFakeBoard({ version: 3, minClient: 1 }, [], async (dir) => {
    const tick = await run('board', ['internal', 'dispatch', '--dry-run'], dir);
    assert.equal(tick.code, 0, tick.stderr);
    assert.match(tick.stdout, /^skipped: the board server is older than this CLI: it speaks API 3.*\n$/);
    assert.equal(tick.stderr, '');
    const tasks = await run('board', ['tasks'], dir);
    assert.equal(tasks.code, 1);
    assert.match(tasks.stderr, /the board server is older than this CLI/);
  });
});

test('a board that no longer serves this CLI fails a command and a tick, saying how to update', async () => {
  await withFakeBoard({ version: 99, minClient: 99 }, [], async (dir) => {
    for (const args of [['tasks'], ['internal', 'dispatch', '--dry-run']]) {
      const result = await run('board', args, dir);
      assert.equal(result.code, 1, args.join(' '));
      assert.match(
        result.stderr,
        /this CLI is older than the board server: it speaks API \d+, the server serves clients from 99/,
      );
    }
  });
});

test('a task with a status this CLI does not know is left out of the list, with one warning on stderr', async () => {
  const known = await wireTask({ id: 'Ab3dEf9x', title: 'Fix the thing' });
  const list = [
    known,
    { ...known, id: 'Fu7ureT1', status: 'snoozed' },
    { ...known, id: 'Fu7ureT2', status: 'snoozed' },
  ];
  await withFakeBoard({ version: 99, minClient: 7 }, list, async (dir) => {
    const result = await run('board', ['tasks'], dir);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Ab3dEf9x/);
    assert.doesNotMatch(result.stdout, /Fu7ureT/);
    assert.equal(
      result.stderr,
      'board: skipped a task with status "snoozed" this CLI does not know (text in quotes is the server\'s, not part of the board); run "git pull" and "pnpm install" in the checkout\n',
    );
  });
});

test('__complete is gone after about two seconds of wall time, whatever is in flight', async () => {
  const dir = emptyConfigDir();
  const sockets = new Set<Socket>();
  // A board that takes the connection and never answers: the version check and the list would each wait for their own timeout.
  const server = createServer(() => undefined);
  server.on('connection', (socket) => sockets.add(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    writeFileSync(join(dir, 'web.json'), JSON.stringify({ url: `http://127.0.0.1:${port}` }));
    writeFileSync(join(dir, 'env'), ENV_FILE, { mode: 0o600 });
    const started = Date.now();
    const result = await run('board', ['__complete', 'tasks'], dir);
    const took = Date.now() - started;
    assert.deepEqual([result.code, result.stdout], [0, '']);
    assert.ok(took >= 1800 && took < 3500, `took ${took} ms`);
  } finally {
    for (const socket of sockets) socket.destroy();
    server.close();
    rmSync(dir, { recursive: true });
  }
});

test('init reads the token from a pipe with --token-file /dev/stdin, and writes env with mode 600', async () => {
  const dir = emptyConfigDir();
  const board = await fakeBoard();
  try {
    const keyFile = join(dir, 'datakey');
    writeFileSync(keyFile, `${encodeDataKey(DATA_KEY)}\n`, { mode: 0o600 });
    const result = await new Promise<Result>((resolve) => {
      execFile(
        'sh',
        [
          '-c',
          'printf %s "$TOKEN" | "$BOARD" init --url "$URL" --token-file /dev/stdin --data-key-file "$KEYFILE" --machine box',
        ],
        {
          env: {
            ...process.env,
            AGENT_BOARD_CONFIG_DIR: dir,
            TOKEN: 'abm_piped',
            URL: board.url,
            KEYFILE: keyFile,
            BOARD: join(BIN, 'board'),
            AGENT_BOARD_TASK: '',
          },
        },
        (error, stdout, stderr) =>
          resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, stdout, stderr }),
      );
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      readFileSync(join(dir, 'env'), 'utf8'),
      `AGENT_BOARD_TOKEN=abm_piped\nAGENT_BOARD_DATA_KEY=${encodeDataKey(DATA_KEY)}\n`,
    );
    assert.equal(statSync(join(dir, 'env')).mode & 0o777, 0o600);
    assert.ok(!result.stdout.includes('abm_piped'));
  } finally {
    await board.close();
    rmSync(dir, { recursive: true });
  }
});

test('init without --machine names the machine as the board does', async () => {
  const dir = emptyConfigDir();
  const board = await fakeBoard('tnk_one');
  try {
    const keyFile = join(dir, 'datakey');
    writeFileSync(keyFile, `${encodeDataKey(DATA_KEY)}\n`, { mode: 0o600 });
    const tokenFile = join(dir, 'token');
    writeFileSync(tokenFile, 'abm_piped\n', { mode: 0o600 });
    const result = await run(
      'board',
      ['init', '--url', board.url, '--token-file', tokenFile, '--data-key-file', keyFile],
      dir,
    );
    assert.equal(result.code, 0, result.stderr);
    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as { machine: string };
    assert.equal(config.machine, 'tnk_one');
  } finally {
    await board.close();
    rmSync(dir, { recursive: true });
  }
});

test('loopback goes on NO_PROXY, after what is there, once', () => {
  const env: Record<string, string | undefined> = { NO_PROXY: 'internal.example, localhost' };
  keepLoopbackOffProxy(env);
  keepLoopbackOffProxy(env);
  assert.equal(env['NO_PROXY'], 'internal.example,localhost,127.0.0.1,[::1],::1');
  assert.equal(env['no_proxy'], 'localhost,127.0.0.1,[::1],::1');
});

test('a board on loopback is never sent through a proxy, even when node is told to use one', async () => {
  const dir = emptyConfigDir();
  const proxied: string[] = [];
  const proxy = createServer((request, response) => {
    proxied.push(`${request.method} ${request.url} ${request.headers.authorization ?? ''}`);
    response.writeHead(502).end();
  });
  const board = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const command = request.url?.split('/').pop();
      response.end(
        JSON.stringify({
          result: command === 'version' ? VERSION_ANSWER : [sealedTask],
        }),
      );
    });
  });
  await Promise.all(
    [proxy, board].map((server) => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))),
  );
  try {
    writeFileSync(
      join(dir, 'web.json'),
      JSON.stringify({ url: `http://127.0.0.1:${(board.address() as AddressInfo).port}` }),
    );
    writeFileSync(join(dir, 'env'), ENV_FILE, { mode: 0o600 });
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    const result = await run('board', ['tasks'], dir, {
      NODE_USE_ENV_PROXY: '1',
      HTTP_PROXY: proxyUrl,
      http_proxy: proxyUrl,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Fix the thing/);
    assert.deepEqual(proxied, []);
  } finally {
    proxy.close();
    board.close();
    rmSync(dir, { recursive: true });
  }
});

// The reader of a pipe that closes at once: the output is dropped, and the exit code is still the command's own.
function throughClosedPipe(args: string, dir: string): Promise<{ code: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'bash',
      ['-c', `"$BOARD" ${args} 2>"$ERR" | head -c0; echo "\${PIPESTATUS[0]}"`],
      {
        env: {
          ...process.env,
          AGENT_BOARD_CONFIG_DIR: dir,
          AGENT_BOARD_TASK: '',
          BOARD: join(BIN, 'board'),
          ERR: join(dir, 'stderr'),
        },
      },
      (_error, stdout) => resolve({ code: stdout.trim(), stderr: readFileSync(join(dir, 'stderr'), 'utf8') }),
    );
  });
}

test('a closed pipe drops the output and keeps the exit code: doctor | head keeps 1, help | head stays 0', async () => {
  const dir = emptyConfigDir();
  try {
    assert.deepEqual(await throughClosedPipe('doctor', dir), { code: '1', stderr: '' });
    assert.deepEqual(await throughClosedPipe('help', dir), { code: '0', stderr: '' });
  } finally {
    rmSync(dir, { recursive: true });
  }
});
