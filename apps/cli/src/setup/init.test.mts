import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { encodeDataKey } from '@agent-board/shared';
import { BackendError } from '../backend/backend.mts';
import type { ServerIdentity } from '../backend/contract-check.mts';
import { DATA_KEY, KEYS, OWNER, SERVER_API, SERVER_HAS } from '../__tests__/helpers/fakes.mts';
import { UsageError } from '../cli.mts';
import { runBoard } from '../commands/program.mts';
import { init, machineProblem, tokenProblem, urlProblem } from './init.mts';
import type { InitDeps, Prompts } from './init.mts';

const TOKEN = 'abm_secretsecretsecret';
const KEY_TEXT = encodeDataKey(DATA_KEY);
const ENV_TEXT = `AGENT_BOARD_TOKEN=${TOKEN}\nAGENT_BOARD_DATA_KEY=${KEY_TEXT}\n`;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'board-init-test-'));
}

const NO_PROMPTS: Prompts = {
  text: async () => assert.fail('no question expected'),
  secret: async () => assert.fail('no question expected'),
};

function deps(configDir: string, overrides: Partial<InitDeps> = {}): InitDeps & { printed: string[] } {
  const printed: string[] = [];
  return {
    configDir,
    interactive: false,
    prompts: NO_PROMPTS,
    hostName: 'laptop',
    now: () => new Date('2026-11-14T10:20:30.123Z'),
    print: (line) => printed.push(line),
    verifyServer: async () => board(),
    printed,
    ...overrides,
  };
}

function keyFile(dir: string, key = KEY_TEXT, name = 'datakey'): string {
  const path = join(dir, name);
  writeFileSync(path, `${key}\n`, { mode: 0o600 });
  return path;
}

function tokenFile(dir: string, token = TOKEN, name = 'token'): string {
  const path = join(dir, name);
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return path;
}

function board(overrides: Partial<ServerIdentity> = {}): ServerIdentity {
  return { owner: OWNER, keyId: KEYS.keyId, api: SERVER_API, features: SERVER_HAS, ...overrides };
}

const mode = (path: string): number => statSync(path).mode & 0o777;

test('init writes web.json, env with mode 600 and a config.json with the machine name', async () => {
  const dir = tempDir();
  const configDir = join(dir, 'cfg');
  try {
    const result = await init(deps(configDir), {
      url: 'https://board.example.com/',
      tokenFile: tokenFile(dir),
      dataKeyFile: keyFile(dir),
      machine: 'box-1',
    });
    assert.equal(result.written.length, 3);
    assert.deepEqual(JSON.parse(readFileSync(join(configDir, 'web.json'), 'utf8')), {
      url: 'https://board.example.com',
    });
    assert.equal(readFileSync(join(configDir, 'env'), 'utf8'), ENV_TEXT);
    assert.equal(mode(join(configDir, 'env')), 0o600);
    const config = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8')) as {
      machine: string;
      lanes: object;
    };
    assert.equal(config.machine, 'box-1');
    const example = JSON.parse(readFileSync(new URL('../../config.example.json', import.meta.url), 'utf8')) as {
      lanes: object;
    };
    assert.deepEqual(config.lanes, example.lanes);
    assert.ok(!readFileSync(join(configDir, 'web.json'), 'utf8').includes(TOKEN));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('init keeps existing files without --force and says so, without asking anything', async () => {
  const dir = tempDir();
  const configDir = join(dir, 'cfg');
  try {
    const flags = {
      url: 'https://board.example.com',
      tokenFile: tokenFile(dir),
      dataKeyFile: keyFile(dir),
      machine: 'box-1',
    };
    await init(deps(configDir), flags);
    writeFileSync(join(configDir, 'config.json'), '{"machine": "mine"}');
    const again = deps(configDir, { interactive: true });
    const result = await init(again, {});
    assert.deepEqual(result.written, []);
    assert.equal(result.skipped.length, 3);
    assert.ok(again.printed.some((line) => line.startsWith(`kept ${join(configDir, 'env')}`)));
    assert.equal(readFileSync(join(configDir, 'config.json'), 'utf8'), '{"machine": "mine"}');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('init --force backs up web.json and env first, keeps the env mode, and never replaces config.json', async () => {
  const dir = tempDir();
  const configDir = join(dir, 'cfg');
  try {
    await init(deps(configDir), {
      url: 'https://old.example.com',
      tokenFile: tokenFile(dir, 'abm_old'),
      dataKeyFile: keyFile(dir),
      machine: 'm',
    });
    writeFileSync(join(configDir, 'config.json'), '{"machine": "mine"}');
    const result = await init(deps(configDir), {
      url: 'https://new.example.com',
      tokenFile: tokenFile(dir, 'abm_new'),
      dataKeyFile: keyFile(dir),
      force: true,
    });
    assert.equal(result.backedUp.length, 2);
    const stamp = '2026-11-14T10-20-30-123Z';
    assert.deepEqual(readdirSync(configDir).sort(), [
      'config.json',
      'env',
      `env.bak-${stamp}`,
      'web.json',
      `web.json.bak-${stamp}`,
    ]);
    assert.equal(
      readFileSync(join(configDir, `env.bak-${stamp}`), 'utf8'),
      `AGENT_BOARD_TOKEN=abm_old\nAGENT_BOARD_DATA_KEY=${KEY_TEXT}\n`,
    );
    assert.equal(mode(join(configDir, `env.bak-${stamp}`)), 0o600);
    assert.equal(
      readFileSync(join(configDir, 'env'), 'utf8'),
      `AGENT_BOARD_TOKEN=abm_new\nAGENT_BOARD_DATA_KEY=${KEY_TEXT}\n`,
    );
    assert.equal(mode(join(configDir, 'env')), 0o600);
    assert.equal(readFileSync(join(configDir, 'config.json'), 'utf8'), '{"machine": "mine"}');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('init without a terminal names the flag it misses instead of waiting', async () => {
  const dir = tempDir();
  try {
    await assert.rejects(
      init(deps(join(dir, 'a')), { tokenFile: tokenFile(dir), dataKeyFile: keyFile(dir) }),
      /give --url/,
    );
    await assert.rejects(init(deps(join(dir, 'b')), { url: 'https://board.example.com' }), /give --token-file/);
    await assert.rejects(
      init(deps(join(dir, 'c')), { url: 'https://board.example.com', tokenFile: tokenFile(dir) }),
      /give --data-key-file/,
    );
    assert.deepEqual(readdirSync(dir).sort(), ['datakey', 'token'], 'nothing is written before every value is known');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('init refuses a bad URL, a token that is not a machine token and an unsafe machine name', async () => {
  const dir = tempDir();
  try {
    const good = { url: 'https://board.example.com', tokenFile: tokenFile(dir), dataKeyFile: keyFile(dir) };
    await assert.rejects(
      init(deps(join(dir, 'a')), { ...good, url: 'http://board.example.com' }),
      /https unless it is localhost/,
    );
    await assert.rejects(init(deps(join(dir, 'b')), { ...good, url: 'nope' }), UsageError);
    await assert.rejects(
      init(deps(join(dir, 'c')), {
        ...good,
        tokenFile: tokenFile(dir, 'hunter2', 'bad-token'),
        dataKeyFile: keyFile(dir),
      }),
      /starts with abm_/,
    );
    await assert.rejects(
      init(deps(join(dir, 'd')), { ...good, tokenFile: join(dir, 'missing') }),
      /token file missing/,
    );
    await assert.rejects(init(deps(join(dir, 'e')), { ...good, machine: 'bad name' }), /machine name/);
    await init(deps(join(dir, 'f')), { ...good, url: 'http://localhost:3000' });
    assert.equal(urlProblem('https://board.example.com'), undefined);
    assert.equal(tokenProblem(TOKEN), undefined);
    assert.equal(machineProblem('box-1'), undefined);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('init asks for what is missing at a terminal, with the host name as the machine default', async () => {
  const dir = tempDir();
  const asked: string[] = [];
  const prompts: Prompts = {
    text: async (message, { defaultValue, validate }) => {
      asked.push(message);
      if (!message.startsWith('Machine')) assert.equal(validate('nope') === undefined, false);
      return message.startsWith('Machine') ? (defaultValue ?? '') : 'https://board.example.com';
    },
    secret: async (message, { validate }) => {
      asked.push(message);
      assert.equal(validate('hunter2') === undefined, false);
      return message.startsWith('Data key') ? KEY_TEXT : TOKEN;
    },
  };
  try {
    await init(deps(join(dir, 'cfg'), { interactive: true, prompts }), {});
    assert.equal(asked.length, 4);
    const config = JSON.parse(readFileSync(join(dir, 'cfg', 'config.json'), 'utf8')) as { machine: string };
    assert.equal(config.machine, 'laptop');
    assert.equal(mode(join(dir, 'cfg', 'env')), 0o600);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('board init runs the doctor checks after writing, and is refused inside a run', async () => {
  const dir = tempDir();
  const out: string[] = [];
  const configDir = join(dir, 'cfg');
  const env = { AGENT_BOARD_CONFIG_DIR: configDir, XDG_CONFIG_HOME: join(dir, 'xdg'), PATH: '' };
  const verified: string[] = [];
  try {
    await runBoard(
      [
        'init',
        '--url',
        'https://board.example.com',
        '--token-file',
        tokenFile(dir),
        '--data-key-file',
        keyFile(dir),
        '--machine',
        'box',
      ],
      {
        env,
        writeOut: (text) => out.push(text),
        interactive: false,
        verifyServer: async (config) => {
          verified.push(config.url);
          return { owner: OWNER, keyId: KEYS.keyId, api: SERVER_API, features: SERVER_HAS };
        },
        systemctlCode: async () => 1,
        platform: 'linux',
      },
    );
    assert.deepEqual(verified, ['https://board.example.com', 'https://board.example.com']);
    const text = out.join('');
    assert.match(text, /wrote .*web\.json/);
    assert.match(text, /✓ server: https:\/\/board\.example\.com answers/);
    assert.match(text, /Next, on a worker machine: board setup/);
    assert.match(text, /✓ board key: the board's data key is id /);
    assert.ok(!text.includes(TOKEN) && !text.includes(KEY_TEXT));
    await assert.rejects(
      runBoard(['init'], { env: { ...env, AGENT_BOARD_TASK: 'Zt0Test1' } }),
      /not available inside a board run/,
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('board init points to board setup on Linux and macOS, and not on another system', async () => {
  for (const [platform, hint] of [
    ['linux', true],
    ['darwin', true],
    ['freebsd', false],
  ] as const) {
    const dir = tempDir();
    const out: string[] = [];
    try {
      await runBoard(
        ['init', '--url', 'https://board.example.com', '--token-file', tokenFile(dir), '--data-key-file', keyFile(dir)],
        {
          env: { AGENT_BOARD_CONFIG_DIR: join(dir, 'cfg'), XDG_CONFIG_HOME: join(dir, 'xdg'), HOME: dir, PATH: '' },
          writeOut: (text) => out.push(text),
          interactive: false,
          platform,
          verifyServer: async () => ({ owner: OWNER, keyId: KEYS.keyId, api: SERVER_API, features: SERVER_HAS }),
          systemctlCode: async () => 1,
          agentLoaded: async () => false,
        },
      ).catch(() => undefined);
      assert.equal(out.join('').includes('Next, on a worker machine: board setup'), hint, platform);
    } finally {
      rmSync(dir, { recursive: true });
    }
  }
});

test('an unreachable board fails init before anything is written', async () => {
  const dir = tempDir();
  try {
    await assert.rejects(
      runBoard(
        ['init', '--url', 'https://board.example.com', '--token-file', tokenFile(dir), '--data-key-file', keyFile(dir)],
        {
          env: { AGENT_BOARD_CONFIG_DIR: join(dir, 'cfg'), XDG_CONFIG_HOME: join(dir, 'xdg'), PATH: '' },
          writeOut: () => undefined,
          interactive: false,
          verifyServer: async () => {
            throw new Error('cannot reach https://board.example.com');
          },
          systemctlCode: async () => 1,
          platform: 'linux',
        },
      ),
      /nothing was written/,
    );
    assert.throws(() => statSync(join(dir, 'cfg', 'env')));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// A prompt that behaves like clack: validate sees the raw input before any default is applied, and the raw value comes back.
function clackLike(answers: { text: string[]; secret: string[] }): Prompts & { asked: string[] } {
  const asked: string[] = [];
  const take = (
    queue: string[],
    message: string,
    validate: (value: string) => string | undefined,
    defaultValue?: string,
  ): string => {
    asked.push(message);
    const raw = queue.shift() ?? '';
    const problem = validate(raw);
    if (problem !== undefined) throw new Error(`prompt validation: ${problem}`);
    return raw === '' ? (defaultValue ?? '') : raw;
  };
  return {
    asked,
    text: async (message, { defaultValue, validate }) => take(answers.text, message, validate, defaultValue),
    secret: async (message, { validate }) => take(answers.secret, message, validate),
  };
}

test('prompt answers are trimmed, and Enter accepts the machine name default', async () => {
  const dir = tempDir();
  try {
    const prompts = clackLike({
      text: ['  https://board.example.com  ', ''],
      secret: [`  ${TOKEN}\n`, ` ${KEY_TEXT} `],
    });
    await init(deps(join(dir, 'cfg'), { interactive: true, prompts, hostName: 'laptop' }), {});
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'cfg', 'web.json'), 'utf8')), {
      url: 'https://board.example.com',
    });
    assert.equal(readFileSync(join(dir, 'cfg', 'env'), 'utf8'), ENV_TEXT);
    assert.equal(
      (JSON.parse(readFileSync(join(dir, 'cfg', 'config.json'), 'utf8')) as { machine: string }).machine,
      'laptop',
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a URL with embedded whitespace is refused by the prompt, and by the URL rule itself', async () => {
  assert.match(urlProblem('https://board.example.com/ x') ?? '', /http\(s\) URL/);
  assert.match(urlProblem('https://board example.com') ?? '', /http\(s\) URL/);
  assert.equal(urlProblem(' https://board.example.com '), undefined, 'surrounding spaces are trimmed, not refused');
  const dir = tempDir();
  try {
    const prompts = clackLike({ text: ['https://board.example.com/ x'], secret: [TOKEN, KEY_TEXT] });
    await assert.rejects(init(deps(join(dir, 'cfg'), { interactive: true, prompts }), {}), /prompt validation/);
    assert.throws(() => readdirSync(join(dir, 'cfg')), 'nothing was created');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('init --force with a bad answer changes nothing: no backup, no temp file, web.json stays', async () => {
  const dir = tempDir();
  const configDir = join(dir, 'cfg');
  try {
    await init(deps(configDir), {
      url: 'https://old.example.com',
      tokenFile: tokenFile(dir, 'abm_old'),
      dataKeyFile: keyFile(dir),
      machine: 'm',
    });
    const before = readdirSync(configDir).sort();
    const prompts = clackLike({ text: [' not a url'], secret: [TOKEN, KEY_TEXT] });
    await assert.rejects(init(deps(configDir, { interactive: true, prompts }), { force: true }), /prompt validation/);
    assert.deepEqual(readdirSync(configDir).sort(), before);
    assert.deepEqual(JSON.parse(readFileSync(join(configDir, 'web.json'), 'utf8')), { url: 'https://old.example.com' });
    await assert.rejects(
      init(deps(configDir), { force: true, url: ' not a url', tokenFile: tokenFile(dir), dataKeyFile: keyFile(dir) }),
      /--url/,
    );
    assert.deepEqual(readdirSync(configDir).sort(), before);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a failure while writing leaves every file in place and no temp file behind', async () => {
  const dir = tempDir();
  const configDir = join(dir, 'cfg');
  try {
    await init(deps(configDir), {
      url: 'https://old.example.com',
      tokenFile: tokenFile(dir, 'abm_old'),
      dataKeyFile: keyFile(dir),
      machine: 'm',
    });
    rmSync(join(configDir, 'env'));
    mkdirSync(join(configDir, 'env'));
    writeFileSync(join(configDir, 'env', 'inside'), 'x');
    await assert.rejects(
      init(deps(configDir), {
        force: true,
        url: 'https://new.example.com',
        tokenFile: tokenFile(dir),
        dataKeyFile: keyFile(dir),
      }),
    );
    assert.deepEqual(JSON.parse(readFileSync(join(configDir, 'web.json'), 'utf8')), { url: 'https://old.example.com' });
    assert.deepEqual(readdirSync(configDir).sort(), ['config.json', 'env', 'web.json']);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a dangling symlink in place of env is replaced by a real file', async () => {
  const dir = tempDir();
  const configDir = join(dir, 'cfg');
  try {
    mkdirSync(configDir);
    symlinkSync(join(dir, 'nowhere'), join(configDir, 'env'));
    await init(deps(configDir), {
      url: 'https://board.example.com',
      tokenFile: tokenFile(dir),
      dataKeyFile: keyFile(dir),
      machine: 'm',
    });
    assert.equal(statSync(join(configDir, 'env')).isFile(), true);
    assert.equal(readFileSync(join(configDir, 'env'), 'utf8'), ENV_TEXT);
    assert.equal(mode(join(configDir, 'env')), 0o600);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('only the values whose file will be written are asked for', async () => {
  const dir = tempDir();
  const configDir = join(dir, 'cfg');
  try {
    await init(deps(configDir), {
      url: 'https://board.example.com',
      tokenFile: tokenFile(dir),
      dataKeyFile: keyFile(dir),
      machine: 'm',
    });
    rmSync(join(configDir, 'env'));
    const result = await init(deps(configDir), { tokenFile: tokenFile(dir, 'abm_new'), dataKeyFile: keyFile(dir) });
    assert.deepEqual(result.written, [join(configDir, 'env')]);
    rmSync(join(configDir, 'env'));
    const prompts = clackLike({ text: [], secret: [TOKEN, KEY_TEXT] });
    await init(deps(configDir, { interactive: true, prompts }), {});
    assert.deepEqual(prompts.asked, [
      'Machine token (not shown)',
      "Data key (not shown; copy it from the board's Settings page)",
    ]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a token file is held to the same mode as env', async () => {
  const dir = tempDir();
  try {
    const wide = tokenFile(dir);
    chmodSync(wide, 0o644);
    await assert.rejects(
      init(deps(join(dir, 'cfg')), { url: 'https://board.example.com', tokenFile: wide }),
      /token file must be mode 600 or 400, is 644/,
    );
    assert.throws(() => readdirSync(join(dir, 'cfg')));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('config.json is always kept, and the line says so', async () => {
  const dir = tempDir();
  const configDir = join(dir, 'cfg');
  try {
    const first = deps(configDir);
    await init(first, {
      url: 'https://board.example.com',
      tokenFile: tokenFile(dir),
      dataKeyFile: keyFile(dir),
      machine: 'm',
    });
    const second = deps(configDir);
    await init(second, {
      force: true,
      url: 'https://board.example.com',
      tokenFile: tokenFile(dir),
      dataKeyFile: keyFile(dir),
    });
    assert.ok(second.printed.some((line) => /kept .*config\.json \(config\.json is always kept/.test(line)));
    assert.ok(!second.printed.some((line) => /config\.json.*--force/.test(line)));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

const CONFIG_ARGS = { url: 'https://board.example.com', machine: 'm' };

test('init writes the data key into env, and never prints it', async () => {
  const dir = tempDir();
  try {
    const run = deps(join(dir, 'cfg'));
    await init(run, { ...CONFIG_ARGS, tokenFile: tokenFile(dir), dataKeyFile: keyFile(dir) });
    assert.equal(readFileSync(join(dir, 'cfg', 'env'), 'utf8'), ENV_TEXT);
    assert.equal(mode(join(dir, 'cfg', 'env')), 0o600);
    assert.ok(!run.printed.join('\n').includes(KEY_TEXT));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a data key that is not one is refused without echoing it, before anything is written', async () => {
  const dir = tempDir();
  try {
    const damaged = `${KEY_TEXT}-damaged`;
    await assert.rejects(
      init(deps(join(dir, 'cfg')), { ...CONFIG_ARGS, tokenFile: tokenFile(dir), dataKeyFile: keyFile(dir, damaged) }),
      (error: Error) =>
        error.message.startsWith('the data key: a data key is abk1_') && !error.message.includes(damaged),
    );
    assert.throws(() => readdirSync(join(dir, 'cfg')));
    const wide = keyFile(dir, KEY_TEXT, 'wide');
    chmodSync(wide, 0o644);
    await assert.rejects(
      init(deps(join(dir, 'cfg')), { ...CONFIG_ARGS, tokenFile: tokenFile(dir), dataKeyFile: wide }),
      /data key file must be mode 600 or 400, is 644/,
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('only one of the two secret files can be /dev/stdin', async () => {
  const dir = tempDir();
  try {
    await assert.rejects(
      init(deps(join(dir, 'cfg')), { ...CONFIG_ARGS, tokenFile: '/dev/stdin', dataKeyFile: '/dev/stdin' }),
      /same file|only one of/,
    );
    await assert.rejects(
      init(deps(join(dir, 'cfg')), { ...CONFIG_ARGS, tokenFile: '/dev/stdin', dataKeyFile: '/proc/self/fd/0' }),
      /only one of --token-file and --data-key-file can be \/dev\/stdin/,
    );
    assert.throws(() => readdirSync(join(dir, 'cfg')));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('--force without a secret given again keeps the current one, and other lines of env stay', async () => {
  const dir = tempDir();
  const configDir = join(dir, 'cfg');
  try {
    await init(deps(configDir), { ...CONFIG_ARGS, tokenFile: tokenFile(dir, 'abm_old'), dataKeyFile: keyFile(dir) });
    writeFileSync(join(configDir, 'env'), `${readFileSync(join(configDir, 'env'), 'utf8')}EXTRA=1\n`, { mode: 0o600 });
    await init(deps(configDir), { force: true, url: 'https://new.example.com', tokenFile: tokenFile(dir, 'abm_new') });
    assert.equal(
      readFileSync(join(configDir, 'env'), 'utf8'),
      `AGENT_BOARD_TOKEN=abm_new\nAGENT_BOARD_DATA_KEY=${KEY_TEXT}\nEXTRA=1\n`,
    );
    await init(deps(configDir), { force: true, url: 'https://new.example.com', dataKeyFile: keyFile(dir) });
    assert.match(readFileSync(join(configDir, 'env'), 'utf8'), /^AGENT_BOARD_TOKEN=abm_new\n/);
    assert.equal(mode(join(configDir, 'env')), 0o600);
    assert.ok(readdirSync(configDir).some((name) => name.startsWith('env.bak-')));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('--force at a terminal keeps what Enter leaves empty', async () => {
  const dir = tempDir();
  const configDir = join(dir, 'cfg');
  try {
    await init(deps(configDir), { ...CONFIG_ARGS, tokenFile: tokenFile(dir, 'abm_old'), dataKeyFile: keyFile(dir) });
    const prompts = clackLike({ text: ['https://board.example.com'], secret: ['', ''] });
    await init(deps(configDir, { interactive: true, prompts }), { force: true });
    assert.equal(
      readFileSync(join(configDir, 'env'), 'utf8'),
      `AGENT_BOARD_TOKEN=abm_old\nAGENT_BOARD_DATA_KEY=${KEY_TEXT}\n`,
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('an env with a token but no data key is completed without --force: only the key is asked for', async () => {
  const dir = tempDir();
  const configDir = join(dir, 'cfg');
  try {
    await init(deps(configDir), { ...CONFIG_ARGS, tokenFile: tokenFile(dir), dataKeyFile: keyFile(dir) });
    writeFileSync(join(configDir, 'env'), 'AGENT_BOARD_TOKEN=abm_kept\n', { mode: 0o600 });
    const prompts = clackLike({ text: [], secret: [KEY_TEXT] });
    const run = deps(configDir, { interactive: true, prompts });
    const result = await init(run, {});
    assert.deepEqual(prompts.asked, ["Data key (not shown; copy it from the board's Settings page)"]);
    assert.equal(
      readFileSync(join(configDir, 'env'), 'utf8'),
      `AGENT_BOARD_TOKEN=abm_kept\nAGENT_BOARD_DATA_KEY=${KEY_TEXT}\n`,
    );
    assert.equal(mode(join(configDir, 'env')), 0o600);
    assert.equal(result.backedUp.length, 1, 'the old env is backed up first');
    assert.ok(run.printed.some((line) => line.includes('has a token and no data key: asking for the data key only')));
    // Complete now: nothing left to do, and nothing asked.
    const again = await init(deps(configDir), {});
    assert.deepEqual(again.written, []);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('an env with a data key but no token is completed the same way', async () => {
  const dir = tempDir();
  const configDir = join(dir, 'cfg');
  try {
    await init(deps(configDir), { ...CONFIG_ARGS, tokenFile: tokenFile(dir), dataKeyFile: keyFile(dir) });
    writeFileSync(join(configDir, 'env'), `AGENT_BOARD_DATA_KEY=${KEY_TEXT}\n`, { mode: 0o600 });
    await init(deps(configDir), { tokenFile: tokenFile(dir, 'abm_added') });
    assert.equal(
      readFileSync(join(configDir, 'env'), 'utf8'),
      `AGENT_BOARD_TOKEN=abm_added\nAGENT_BOARD_DATA_KEY=${KEY_TEXT}\n`,
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('the key checks never print the key: a failing init names the flag, not the value', async () => {
  const dir = tempDir();
  try {
    await assert.rejects(
      init(deps(join(dir, 'cfg')), { ...CONFIG_ARGS, tokenFile: tokenFile(dir) }),
      /the data key is needed and there is no terminal to ask: give --data-key-file/,
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

const BOTH_LINES = (token: string): string => `AGENT_BOARD_TOKEN=${token}\nAGENT_BOARD_DATA_KEY=${KEY_TEXT}`;

test('completing a partial env, a secret given by flag wins over the one in env', async () => {
  const dir = tempDir();
  const configDir = join(dir, 'cfg');
  try {
    await init(deps(configDir), { ...CONFIG_ARGS, tokenFile: tokenFile(dir, 'abm_old'), dataKeyFile: keyFile(dir) });
    writeFileSync(join(configDir, 'env'), 'AGENT_BOARD_TOKEN=abm_old\n', { mode: 0o600 });
    await init(deps(configDir), { tokenFile: tokenFile(dir, 'abm_new'), dataKeyFile: keyFile(dir) });
    assert.equal(
      readFileSync(join(configDir, 'env'), 'utf8'),
      `AGENT_BOARD_TOKEN=abm_new\nAGENT_BOARD_DATA_KEY=${KEY_TEXT}\n`,
    );
    // Not given: carried over; given but invalid: refused, and nothing changes.
    writeFileSync(join(configDir, 'env'), 'AGENT_BOARD_TOKEN=abm_old\n', { mode: 0o600 });
    await assert.rejects(
      init(deps(configDir), { tokenFile: tokenFile(dir, 'hunter2', 'bad'), dataKeyFile: keyFile(dir) }),
      /the token: a machine token starts with abm_/,
    );
    assert.equal(readFileSync(join(configDir, 'env'), 'utf8'), 'AGENT_BOARD_TOKEN=abm_old\n');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('an env backup is never wider than 600', async () => {
  const dir = tempDir();
  const configDir = join(dir, 'cfg');
  try {
    mkdirSync(configDir);
    writeFileSync(join(configDir, 'env'), ENV_TEXT);
    chmodSync(join(configDir, 'env'), 0o644);
    writeFileSync(join(configDir, 'web.json'), '{"url": "https://board.example.com"}');
    await init(deps(configDir), { force: true, machine: 'm', tokenFile: tokenFile(dir), dataKeyFile: keyFile(dir) });
    const backup = readdirSync(configDir).find((name) => name.startsWith('env.bak-')) ?? '';
    assert.equal(mode(join(configDir, backup)), 0o600);
    assert.equal(mode(join(configDir, 'env')), 0o600);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('the Settings page copies env lines: a file may hold both; a prompt takes one line, bare or NAME=value', async () => {
  const dir = tempDir();
  try {
    // The data key line alone, for --data-key-file; the token bare.
    await init(deps(join(dir, 'a')), {
      ...CONFIG_ARGS,
      tokenFile: tokenFile(dir),
      dataKeyFile: keyFile(dir, `AGENT_BOARD_DATA_KEY=${KEY_TEXT}`, 'line'),
    });
    assert.equal(readFileSync(join(dir, 'a', 'env'), 'utf8'), ENV_TEXT);
    // Both lines in one token file: the key needs no flag.
    await init(deps(join(dir, 'b')), { ...CONFIG_ARGS, tokenFile: tokenFile(dir, BOTH_LINES(TOKEN), 'both') });
    assert.equal(readFileSync(join(dir, 'b', 'env'), 'utf8'), ENV_TEXT);
    // Both lines in the data key file: the token needs no flag.
    await init(deps(join(dir, 'c')), { ...CONFIG_ARGS, dataKeyFile: keyFile(dir, BOTH_LINES(TOKEN), 'both2') });
    assert.equal(readFileSync(join(dir, 'c', 'env'), 'utf8'), ENV_TEXT);
    // A value for its own flag wins over the one in the other file.
    await init(deps(join(dir, 'd')), {
      ...CONFIG_ARGS,
      tokenFile: tokenFile(dir, 'abm_own', 'own'),
      dataKeyFile: keyFile(dir, BOTH_LINES('abm_other'), 'both3'),
    });
    assert.match(readFileSync(join(dir, 'd', 'env'), 'utf8'), /^AGENT_BOARD_TOKEN=abm_own\n/);
    // At a terminal each prompt takes one line, which is the bare value or its own NAME=value line.
    const lines = clackLike({
      text: ['https://board.example.com', 'm'],
      secret: [`AGENT_BOARD_TOKEN=${TOKEN}`, `AGENT_BOARD_DATA_KEY=${KEY_TEXT}`],
    });
    await init(deps(join(dir, 'f'), { interactive: true, prompts: lines }), {});
    assert.equal(readFileSync(join(dir, 'f', 'env'), 'utf8'), ENV_TEXT);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a secret given where a file path belongs is refused without being echoed', async () => {
  const dir = tempDir();
  try {
    for (const [flags, secret] of [
      [{ dataKeyFile: KEY_TEXT, tokenFile: tokenFile(dir) }, KEY_TEXT],
      [{ tokenFile: TOKEN, dataKeyFile: keyFile(dir) }, TOKEN],
      [{ dataKeyFile: `AGENT_BOARD_DATA_KEY=${KEY_TEXT}`, tokenFile: tokenFile(dir) }, KEY_TEXT],
    ] as const) {
      await assert.rejects(init(deps(join(dir, 'cfg')), { ...CONFIG_ARGS, ...flags }), (error: Error) => {
        assert.match(error.message, /^--(data-key|token)-file takes the path of a file, not the secret itself$/);
        assert.ok(!error.message.includes(secret));
        return true;
      });
    }
    assert.throws(() => readdirSync(join(dir, 'cfg')));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('an env with neither value does not say it asks for only one', async () => {
  const dir = tempDir();
  const configDir = join(dir, 'cfg');
  try {
    mkdirSync(configDir);
    writeFileSync(join(configDir, 'env'), 'OTHER=1\n', { mode: 0o600 });
    const run = deps(configDir);
    await init(run, { ...CONFIG_ARGS, tokenFile: tokenFile(dir), dataKeyFile: keyFile(dir) });
    assert.ok(!run.printed.some((line) => line.includes('asking for')));
    assert.equal(readFileSync(join(configDir, 'env'), 'utf8'), `${ENV_TEXT}OTHER=1\n`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('--force keeps the current URL when none is given, and replaces it, after a backup, when one is', async () => {
  const dir = tempDir();
  const configDir = join(dir, 'cfg');
  try {
    await init(deps(configDir), { ...CONFIG_ARGS, tokenFile: tokenFile(dir), dataKeyFile: keyFile(dir) });
    const kept = deps(configDir);
    await init(kept, { force: true, dataKeyFile: keyFile(dir) });
    assert.deepEqual(JSON.parse(readFileSync(join(configDir, 'web.json'), 'utf8')), {
      url: 'https://board.example.com',
    });
    assert.ok(
      !readdirSync(configDir).some((name) => name.startsWith('web.json.bak-')),
      'no backup of an unchanged file',
    );
    assert.ok(kept.printed.some((line) => line.includes('no --url given')));
    await init(deps(configDir), { force: true, url: 'https://board.example.com/', dataKeyFile: keyFile(dir) });
    assert.ok(!readdirSync(configDir).some((name) => name.startsWith('web.json.bak-')), 'the same URL is no change');
    await init(deps(configDir), { force: true, url: 'https://new.example.com', dataKeyFile: keyFile(dir) });
    assert.ok(readdirSync(configDir).some((name) => name.startsWith('web.json.bak-')));
    // Without a web.json there is nothing to keep: --url is needed.
    rmSync(join(configDir, 'web.json'));
    await assert.rejects(init(deps(configDir), { force: true }), /the board's URL is needed and there is no terminal/);
    // At a terminal, Enter keeps the URL.
    const prompts = clackLike({ text: ['https://board.example.com'], secret: ['', ''] });
    await init(deps(configDir, { interactive: true, prompts }), { force: true });
    const enter = clackLike({ text: ['', ''], secret: ['', ''] });
    await init(deps(configDir, { interactive: true, prompts: enter }), { force: true });
    assert.deepEqual(JSON.parse(readFileSync(join(configDir, 'web.json'), 'utf8')), {
      url: 'https://board.example.com',
    });
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a prompt answered with the other value’s line names what it wants, and nothing is written', async () => {
  const dir = tempDir();
  try {
    const wrongToken = clackLike({
      text: ['https://board.example.com', 'm'],
      secret: [`AGENT_BOARD_DATA_KEY=${KEY_TEXT}`],
    });
    await assert.rejects(
      init(deps(join(dir, 'a'), { interactive: true, prompts: wrongToken }), {}),
      /prompt validation: that is the AGENT_BOARD_DATA_KEY line; this question wants the machine token/,
    );
    const wrongKey = clackLike({
      text: ['https://board.example.com', 'm'],
      secret: [TOKEN, `AGENT_BOARD_TOKEN=${TOKEN}`],
    });
    await assert.rejects(
      init(deps(join(dir, 'b'), { interactive: true, prompts: wrongKey }), {}),
      /prompt validation: that is the AGENT_BOARD_TOKEN line; this question wants the data key/,
    );
    assert.throws(() => readdirSync(join(dir, 'a')));
    assert.throws(() => readdirSync(join(dir, 'b')));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a secret path with a leading space, quotes or export is normalised, and never echoed in "file missing"', async () => {
  const dir = tempDir();
  try {
    const key = KEY_TEXT;
    for (const given of [` ${key}`, `"${key}"`, `export ${key}`, `'${key}'`]) {
      await assert.rejects(
        init(deps(join(dir, 'cfg')), { ...CONFIG_ARGS, tokenFile: tokenFile(dir), dataKeyFile: given }),
        (error: Error) => {
          assert.match(error.message, /^--data-key-file takes the path of a file, not the secret itself$/);
          assert.ok(!error.message.includes(key));
          return true;
        },
      );
    }
    // A secret inside a longer path: the error does not show the path.
    await assert.rejects(
      init(deps(join(dir, 'cfg')), { ...CONFIG_ARGS, tokenFile: `/tmp/x/${TOKEN}`, dataKeyFile: keyFile(dir) }),
      (error: Error) => !error.message.includes(TOKEN) && /no such file/.test(error.message),
    );
    // A real path with the shell's habits around it works.
    await init(deps(join(dir, 'ok')), {
      ...CONFIG_ARGS,
      tokenFile: `  "${tokenFile(dir)}"`,
      dataKeyFile: `export ${keyFile(dir)}`,
    });
    assert.equal(readFileSync(join(dir, 'ok', 'env'), 'utf8'), ENV_TEXT);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('with AGENT_BOARD_CREDENTIALS_COMMAND set, init writes web.json and no env, and the checks load through the command', async () => {
  const dir = tempDir();
  const out: string[] = [];
  const configDir = join(dir, 'cfg');
  const command = join(dir, 'creds');
  writeFileSync(
    command,
    `#!/bin/sh\nprintf '%s\\n' 'AGENT_BOARD_TOKEN=${TOKEN}' 'AGENT_BOARD_DATA_KEY=${KEY_TEXT}'\n`,
    {
      mode: 0o755,
    },
  );
  const env = {
    AGENT_BOARD_CONFIG_DIR: configDir,
    XDG_CONFIG_HOME: join(dir, 'xdg'),
    PATH: '',
    AGENT_BOARD_CREDENTIALS_COMMAND: command,
  };
  const options = {
    env,
    writeOut: (text: string) => out.push(text),
    interactive: false,
    verifyServer: async () => ({ owner: OWNER, keyId: KEYS.keyId, api: SERVER_API, features: SERVER_HAS }),
    systemctlCode: async () => 1,
    platform: 'linux',
  };
  try {
    await runBoard(['init', '--url', 'https://board.example.com', '--machine', 'box'], options);
    assert.ok(existsSync(join(configDir, 'web.json')));
    assert.ok(existsSync(join(configDir, 'config.json')));
    assert.equal(existsSync(join(configDir, 'env')), false);
    const text = out.join('');
    assert.match(text, new RegExp(`✓ credentials: from ${command}`));
    assert.match(text, /✓ board key: the board's data key is id /);
    assert.ok(!text.includes(TOKEN) && !text.includes(KEY_TEXT));

    await assert.rejects(
      runBoard(['init', '--force', '--token-file', tokenFile(dir)], options),
      /AGENT_BOARD_CREDENTIALS_COMMAND.*--token-file/,
    );
    assert.equal(existsSync(join(configDir, 'env')), false);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

const FLAGS = (dir: string) => ({
  url: 'https://board.example.com',
  tokenFile: tokenFile(dir),
  dataKeyFile: keyFile(dir),
});

test('init names the machine as the board does, and writes that name to config.json', async () => {
  const dir = tempDir();
  try {
    const verified: { url: string; token: string }[] = [];
    await init(
      deps(join(dir, 'cfg'), {
        verifyServer: async (config) => {
          verified.push(config);
          return board({ machine: 'tnk_one' });
        },
      }),
      FLAGS(dir),
    );
    assert.deepEqual(verified, [{ url: 'https://board.example.com', token: TOKEN }]);
    const config = JSON.parse(readFileSync(join(dir, 'cfg', 'config.json'), 'utf8')) as { machine: string };
    assert.equal(config.machine, 'tnk_one');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('init through a command that returns a malformed token writes nothing', async () => {
  const dir = tempDir();
  const configDir = join(dir, 'cfg');
  try {
    await assert.rejects(
      init(
        deps(configDir, {
          credentialsCommand: '/usr/local/bin/creds',
          runCredentials: () => ({ AGENT_BOARD_TOKEN: 'nope', AGENT_BOARD_DATA_KEY: KEY_TEXT }),
        }),
        { url: 'https://board.example.com' },
      ),
      UsageError,
    );
    assert.equal(existsSync(configDir), false);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('init does not ask for a machine name when the board names it', async () => {
  const dir = tempDir();
  const asked: string[] = [];
  const prompts: Prompts = {
    text: async (message) => {
      asked.push(message);
      return '';
    },
    secret: async () => assert.fail('no secret expected'),
  };
  try {
    await init(
      deps(join(dir, 'cfg'), { interactive: true, prompts, verifyServer: async () => board({ machine: 'tnk_one' }) }),
      FLAGS(dir),
    );
    assert.deepEqual(asked, []);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('init accepts --machine when it is the board’s name and refuses it otherwise, writing nothing', async () => {
  const dir = tempDir();
  const cfg = join(dir, 'cfg');
  try {
    await assert.rejects(
      init(deps(cfg, { verifyServer: async () => board({ machine: 'tnk_one' }) }), { ...FLAGS(dir), machine: 'mac' }),
      /--machine: the token belongs to the machine tnk_one, not mac/,
    );
    assert.throws(() => statSync(cfg));
    await init(deps(cfg, { verifyServer: async () => board({ machine: 'tnk_one' }) }), {
      ...FLAGS(dir),
      machine: 'tnk_one',
    });
    assert.equal(statSync(join(cfg, 'config.json')).isFile(), true);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('init refused by the board for its token writes nothing and says so', async () => {
  const dir = tempDir();
  const cfg = join(dir, 'cfg');
  try {
    await assert.rejects(
      init(
        deps(cfg, {
          verifyServer: async () => {
            throw new BackendError('unauthorized', 401, true);
          },
        }),
        FLAGS(dir),
      ),
      (error) => error instanceof UsageError && /refused the token.*nothing was written/.test(error.message),
    );
    assert.throws(() => statSync(cfg));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('init that cannot reach the board writes nothing', async () => {
  const dir = tempDir();
  const cfg = join(dir, 'cfg');
  try {
    await assert.rejects(
      init(
        deps(cfg, {
          verifyServer: async () => {
            throw new BackendError('cannot reach https://board.example.com');
          },
        }),
        FLAGS(dir),
      ),
      /cannot check the token with https:\/\/board\.example\.com: .*nothing was written/,
    );
    assert.throws(() => statSync(cfg));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('init with a data key that is not the board’s writes nothing', async () => {
  const dir = tempDir();
  const cfg = join(dir, 'cfg');
  try {
    await assert.rejects(
      init(deps(cfg, { verifyServer: async () => board({ keyId: '0123456789abcdef' }) }), FLAGS(dir)),
      /different data key.*nothing was written/,
    );
    await assert.rejects(
      init(deps(cfg, { verifyServer: async () => board({ keyId: null }) }), FLAGS(dir)),
      /no data key yet.*nothing was written/,
    );
    assert.throws(() => statSync(cfg));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('init warns when a kept config.json names another machine than the token’s', async () => {
  const dir = tempDir();
  const cfg = join(dir, 'cfg');
  try {
    await init(deps(cfg), FLAGS(dir));
    const second = deps(cfg, { verifyServer: async () => board({ machine: 'tnk_one' }) });
    await init(second, { ...FLAGS(dir), force: true });
    assert.ok(second.printed.some((line) => /names the machine box|names the machine laptop/.test(line)));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('init asks the board before writing a web.json that is the only file missing', async () => {
  const dir = tempDir();
  const cfg = join(dir, 'cfg');
  try {
    await init(deps(cfg), FLAGS(dir));
    rmSync(join(cfg, 'web.json'));
    await assert.rejects(
      init(
        deps(cfg, {
          verifyServer: async () => {
            throw new BackendError('unauthorized', 401, true);
          },
        }),
        { url: 'https://other.example.com' },
      ),
      /refused the token.*nothing was written/,
    );
    assert.throws(() => statSync(join(cfg, 'web.json')));
    const checked: string[] = [];
    await init(
      deps(cfg, {
        verifyServer: async (config) => {
          checked.push(config.url);
          return board();
        },
      }),
      { url: 'https://other.example.com' },
    );
    assert.deepEqual(checked, ['https://other.example.com']);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('init with an unreadable web.json and files to write fails without writing', async () => {
  const dir = tempDir();
  const cfg = join(dir, 'cfg');
  try {
    await init(deps(cfg), FLAGS(dir));
    writeFileSync(join(cfg, 'web.json'), 'not json');
    rmSync(join(cfg, 'config.json'));
    await assert.rejects(init(deps(cfg), {}), /no readable board URL.*nothing was written/);
    assert.throws(() => statSync(join(cfg, 'config.json')));
    assert.equal(readFileSync(join(cfg, 'web.json'), 'utf8'), 'not json');
  } finally {
    rmSync(dir, { recursive: true });
  }
});
