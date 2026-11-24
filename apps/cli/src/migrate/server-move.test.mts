import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveKeys, encodeDataKey, generateDataKey } from '@agent-board/shared';
import type { ListedMachine } from '@agent-board/shared';
import { fixture } from '../__tests__/helpers/migration.mts';
import { UsageError } from '../cli.mts';
import { BackendError } from '../backend/backend.mts';
import type { ServerIdentity } from '../backend/contract-check.mts';
import { readBoardAgentsState } from '../config/config.mts';
import { listBackups } from './backup.mts';
import { writeJournal } from './journal.mts';
import { lockPath } from './lock.mts';
import { moveServer } from './server-move.mts';
import type { ServerMoveDeps } from './server-move.mts';

const SOURCE = 'https://old.example.com';
const TARGET = 'https://new.example.com';
const dataKey = generateDataKey();
const keyIdOf = async (owner: string): Promise<string> => (await deriveKeys(dataKey, owner, { index: true })).keyId;

const text = (path: string): string => readFileSync(path, 'utf8');

async function scenario(
  options: {
    sourceOwner?: string;
    targetOwner?: string;
    targetKeyId?: string | null;
    sourceFeatures?: string[];
    agentsVersion?: number;
    machines?: ListedMachine[];
  } = {},
) {
  const f = fixture([]);
  const { configDir, stateDir } = f.deps.paths;
  writeFileSync(join(configDir, 'web.json'), `{\n  "url": "${SOURCE}",\n  "note": "kept"\n}\n`, { mode: 0o640 });
  chmodSync(join(configDir, 'web.json'), 0o640);
  writeFileSync(join(configDir, 'env'), `AGENT_BOARD_TOKEN=abm_x\nAGENT_BOARD_DATA_KEY=${encodeDataKey(dataKey)}\n`, {
    mode: 0o600,
  });
  const owner = options.sourceOwner ?? 'ana';
  const calls = { verify: [] as string[], list: [] as string[], restarts: 0, confirms: 0, workers: 0 };
  const failures: Record<string, Error> = {};
  const identity = async (url: string): Promise<ServerIdentity> => ({
    owner: url === SOURCE ? owner : (options.targetOwner ?? owner),
    keyId:
      url === SOURCE
        ? await keyIdOf(owner)
        : options.targetKeyId === undefined
          ? await keyIdOf(options.targetOwner ?? owner)
          : options.targetKeyId,
    api: { version: 12, minClient: 9 },
    features: new Set(url === SOURCE ? (options.sourceFeatures ?? ['machine.list']) : []),
    ...(url === TARGET && options.agentsVersion !== undefined ? { agentsVersion: options.agentsVersion } : {}),
  });
  const moveDeps: ServerMoveDeps = {
    paths: f.deps.paths,
    platform: 'linux',
    env: f.deps.env,
    home: f.deps.home,
    version: '0.40.0',
    cliApi: 9,
    now: f.deps.now,
    print: f.deps.print,
    interactive: true,
    confirm: async () => {
      calls.confirms += 1;
      return f.answers.shift() ?? false;
    },
    activeWorkers: async () => calls.workers,
    restart: async () => {
      calls.restarts += 1;
      return 'restarted the listener';
    },
    verify: async (config) => {
      calls.verify.push(`${config.url} ${config.token}`);
      const failure = failures[config.url];
      if (failure !== undefined) throw failure;
      return identity(config.url);
    },
    listMachines: async (config) => {
      calls.list.push(config.url);
      return options.machines ?? [];
    },
  };
  f.answers.push(true);
  const web = join(configDir, 'web.json');
  return {
    f,
    moveDeps,
    calls,
    failures,
    web,
    configDir,
    stateDir,
    backups: () => listBackups(stateDir),
    unchanged: () =>
      text(web) === `{\n  "url": "${SOURCE}",\n  "note": "kept"\n}\n` && listBackups(stateDir).length === 0,
  };
}

test('a move writes the new url and keeps every other key and the mode, backs up as a server move and restarts the listener', async () => {
  const s = await scenario();
  try {
    assert.equal(await moveServer(s.moveDeps, TARGET), 'moved');
    assert.deepEqual(JSON.parse(text(s.web)), { url: TARGET, note: 'kept' });
    assert.equal(statSync(s.web).mode & 0o777, 0o640);
    assert.equal(s.backups().length, 1);
    const backup = s.backups()[0];
    assert.equal(backup?.manifest.kind, 'server');
    assert.match(text(join(backup?.dir ?? '', 'config', 'web.json')), /old\.example\.com/);
    assert.deepEqual(
      backup?.manifest.files
        .map((file) => file.path)
        .filter((path) => path.startsWith('config/'))
        .sort(),
      ['config/env', 'config/web.json'],
      'the backup holds the config as it was, without the staged web.json',
    );
    assert.equal(s.calls.restarts, 1);
    assert.deepEqual(s.calls.list, [SOURCE]);
    assert.deepEqual(
      s.calls.verify,
      [`${TARGET} abm_x`, `${SOURCE} abm_x`, `${TARGET} abm_x`],
      'the target before the move, the source once, the target again after it',
    );
    assert.ok(s.f.printed.some((line) => line.includes(`${SOURCE} is unchanged`)));
    assert.ok(s.f.printed.some((line) => line.includes(`board self-update --server ${SOURCE}`)));
    assert.equal(existsSync(lockPath(s.stateDir)), false);
    assert.deepEqual(
      readdirSync(s.configDir).filter((name) => name.startsWith('.')),
      [],
      'no staged file is left',
    );
  } finally {
    rmSync(s.f.dir, { recursive: true });
  }
});

test('a target that does not accept the token changes nothing and says to import the export first', async () => {
  const s = await scenario();
  try {
    s.failures[TARGET] = new BackendError('error from the board server (HTTP 401)', 401, true);
    await assert.rejects(
      moveServer(s.moveDeps, TARGET),
      /does not accept this machine's token: import your board export there first.*nothing was changed/,
    );
    assert.ok(s.unchanged());
    assert.equal(s.calls.restarts, 0);
    assert.deepEqual(s.calls.list, []);
  } finally {
    rmSync(s.f.dir, { recursive: true });
  }
});

test('a target that refuses this CLI as too old passes its message on and changes nothing', async () => {
  const s = await scenario();
  try {
    const error = new BackendError('this CLI is older than the board server; run "board self-update"');
    error.contractMismatch = 'cli-older';
    s.failures[TARGET] = error;
    await assert.rejects(moveServer(s.moveDeps, TARGET), /run "board self-update".*nothing was changed/);
    assert.ok(s.unchanged());
  } finally {
    rmSync(s.f.dir, { recursive: true });
  }
});

test('a target without a data key says to import first and changes nothing', async () => {
  const s = await scenario({ targetKeyId: null });
  try {
    await assert.rejects(
      moveServer(s.moveDeps, TARGET),
      /holds no data key yet: import your board export there first.*nothing was changed/,
    );
    assert.ok(s.unchanged());
  } finally {
    rmSync(s.f.dir, { recursive: true });
  }
});

test('a target with another key id is another board and nothing is changed', async () => {
  const s = await scenario({ targetKeyId: 'kid_other' });
  try {
    await assert.rejects(moveServer(s.moveDeps, TARGET), /holds another board \(key id kid_other.*nothing was changed/);
    assert.ok(s.unchanged());
  } finally {
    rmSync(s.f.dir, { recursive: true });
  }
});

test('a target that signs the user in under another name is refused when the source can be reached', async () => {
  const s = await scenario({ targetOwner: 'bob' });
  try {
    await assert.rejects(
      moveServer(s.moveDeps, TARGET),
      /signs you in as bob, but the board at .* belongs to ana; nothing was changed/,
    );
    assert.ok(s.unchanged());
    assert.equal(s.calls.restarts, 0);
  } finally {
    rmSync(s.f.dir, { recursive: true });
  }
});

test('an unreachable source goes on after the key check and says it cannot tell about other machines', async () => {
  const s = await scenario();
  try {
    s.failures[SOURCE] = new BackendError(`cannot reach ${SOURCE}: fetch failed`);
    assert.equal(await moveServer(s.moveDeps, TARGET), 'moved');
    assert.ok(s.f.printed.some((line) => line.startsWith('cannot tell whether other machines still use')));
    assert.deepEqual(s.calls.list, []);
  } finally {
    rmSync(s.f.dir, { recursive: true });
  }
});

test('a source without machine.list cannot tell either', async () => {
  const s = await scenario({ sourceFeatures: [] });
  try {
    assert.equal(await moveServer(s.moveDeps, TARGET), 'moved');
    assert.ok(s.f.printed.some((line) => line.startsWith('cannot tell whether other machines still use')));
    assert.deepEqual(s.calls.list, []);
  } finally {
    rmSync(s.f.dir, { recursive: true });
  }
});

test('only another machine seen in the last 15 minutes is named', async () => {
  const at = (minutesAgo: number): string =>
    new Date(Date.parse('2026-11-24T10:15:03.000Z') - minutesAgo * 60_000).toISOString();
  const s = await scenario({
    machines: [
      { name: 'this', lastSeenAt: at(0), current: true },
      { name: 'recent', lastSeenAt: at(5), current: false },
      { name: 'stale', lastSeenAt: at(120), current: false },
      { name: 'never', lastSeenAt: null, current: false },
    ],
  });
  try {
    await moveServer(s.moveDeps, TARGET);
    const warning = s.f.printed.find((line) => line.includes('still lists'));
    assert.match(warning ?? '', /1 other machine\(s\).*: recent;/);
    assert.ok(!s.f.printed.some((line) => /stale|never|this;/.test(line)));
  } finally {
    rmSync(s.f.dir, { recursive: true });
  }
});

test('without a terminal the command refuses before any network call', async () => {
  const s = await scenario();
  try {
    s.moveDeps.interactive = false;
    await assert.rejects(moveServer(s.moveDeps, TARGET), /--server needs a terminal.*nothing was changed/);
    assert.deepEqual(s.calls.verify, []);
    assert.ok(s.unchanged());
  } finally {
    rmSync(s.f.dir, { recursive: true });
  }
});

test('the url the machine already uses is left alone, however it is spelled', async () => {
  const s = await scenario();
  try {
    assert.equal(await moveServer(s.moveDeps, 'https://OLD.example.com:443/'), 'unchanged');
    assert.ok(s.f.printed.some((line) => line.includes('already uses https://old.example.com')));
    assert.deepEqual(s.calls.verify, []);
    assert.ok(s.unchanged());
  } finally {
    rmSync(s.f.dir, { recursive: true });
  }
});

test('a target url that is not a plain board url is a usage error and nothing is sent', async () => {
  const s = await scenario();
  try {
    for (const bad of [
      'https://me:secret@new.example.com',
      'https://new.example.com/?token=x',
      'https://new.example.com/#top',
      'ftp://new.example.com',
      'http://new.example.com',
      'new.example.com',
      'https://',
    ])
      await assert.rejects(moveServer(s.moveDeps, bad), UsageError, bad);
    assert.deepEqual(s.calls.verify, []);
    assert.ok(s.unchanged());
  } finally {
    rmSync(s.f.dir, { recursive: true });
  }
});

test('running workers refuse the move before anything is asked or changed', async () => {
  const s = await scenario();
  try {
    s.calls.workers = 2;
    await assert.rejects(moveServer(s.moveDeps, TARGET), /2 worker\(s\) running.*nothing was changed/);
    assert.equal(s.calls.confirms, 0);
    assert.ok(s.unchanged());
  } finally {
    rmSync(s.f.dir, { recursive: true });
  }
});

test('a person who declines changes nothing', async () => {
  const s = await scenario();
  try {
    s.f.answers.length = 0;
    assert.equal(await moveServer(s.moveDeps, TARGET), 'declined');
    assert.ok(s.unchanged());
    assert.equal(s.calls.restarts, 0);
  } finally {
    rmSync(s.f.dir, { recursive: true });
  }
});

test('an unfinished migration refuses the move', async () => {
  const s = await scenario();
  try {
    writeJournal(s.stateDir, {
      version: 1,
      from: '0.37.0',
      to: '0.40.0',
      steps: ['a'],
      done: [],
      backup: 'b',
      startedAt: '2026-11-24T10:15:03.000Z',
    });
    await assert.rejects(moveServer(s.moveDeps, TARGET), /migration is unfinished.*nothing was changed/);
    assert.deepEqual(s.calls.verify, []);
  } finally {
    rmSync(s.f.dir, { recursive: true });
  }
});

test('a web.json that is a symlink is refused, and neither the file nor the backups change', async () => {
  const s = await scenario();
  try {
    const real = join(s.f.dir, 'dotfiles-web.json');
    writeFileSync(real, text(s.web));
    rmSync(s.web);
    symlinkSync(real, s.web);
    await assert.rejects(moveServer(s.moveDeps, TARGET), /not a regular file.*nothing was changed/);
    assert.equal(text(real), `{\n  "url": "${SOURCE}",\n  "note": "kept"\n}\n`);
    assert.equal(s.backups().length, 0);
    assert.equal(s.calls.restarts, 0);
    assert.equal(existsSync(lockPath(s.stateDir)), false);
  } finally {
    rmSync(s.f.dir, { recursive: true });
  }
});

test('a failing check after the move says where the machine points and how to go back', async () => {
  const s = await scenario();
  try {
    const verify = s.moveDeps.verify;
    let targetCalls = 0;
    s.moveDeps.verify = async (config) => {
      if (config.url === TARGET && ++targetCalls === 2) throw new BackendError(`cannot reach ${TARGET}: timed out`);
      return verify(config);
    };
    await assert.rejects(moveServer(s.moveDeps, TARGET), (error: Error) => {
      assert.match(error.message, /after the move failed.*timed out/);
      assert.ok(error.message.includes(`board self-update --server ${SOURCE}`));
      assert.ok(error.message.includes(s.backups()[0]?.dir ?? 'no backup'));
      return true;
    });
    assert.equal(JSON.parse(text(s.web)).url, TARGET);
    assert.equal(existsSync(lockPath(s.stateDir)), false);
  } finally {
    rmSync(s.f.dir, { recursive: true });
  }
});

test('shared agents applied at a version the target has not reached are forgotten, a newer target keeps them', async () => {
  const lower = await scenario({ agentsVersion: 3 });
  const higher = await scenario({ agentsVersion: 9 });
  try {
    for (const s of [lower, higher]) {
      const dir = join(s.configDir, 'agents.board');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'state.json'),
        JSON.stringify({ version: 5, hashes: { a: 'h' }, errors: {}, unmoved: {} }),
      );
      await moveServer(s.moveDeps, TARGET);
    }
    const stateOf = (s: typeof lower) => readBoardAgentsState(join(s.configDir, 'agents.board'));
    assert.equal(stateOf(lower).version, null);
    assert.deepEqual(stateOf(lower).hashes, { a: 'h' });
    assert.equal(stateOf(higher).version, 5);
  } finally {
    rmSync(lower.f.dir, { recursive: true });
    rmSync(higher.f.dir, { recursive: true });
  }
});
