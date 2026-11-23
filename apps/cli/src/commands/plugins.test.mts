import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { UsageError } from '../cli.mts';
import { runGit } from '../config/checkout-repo.mts';
import { VALID_MANIFEST, commitFiles, git, makeMarketplace } from '../__tests__/helpers/marketplace.mts';
import type { FixtureFile } from '../__tests__/helpers/marketplace.mts';
import { tempDir } from '../__tests__/helpers/watch.mts';
import { runTransfer } from '../plugins/git.mts';
import { verifyPin } from '../plugins/pin.mts';
import { checkoutDir, pluginsDir, readRegistry } from '../plugins/registry.mts';
import { resolveIntegration } from '../plugins/resolve.mts';
import { runBoard } from './program.mts';
import { pluginsInstall, pluginsList, pluginsRemove, pluginsUpdate } from './plugins.mts';
import type { PluginsDeps } from './plugins.mts';

const NOW = new Date('2026-11-23T10:00:00Z');

function setup() {
  const root = tempDir('board-plugins-');
  const paths = { stateDir: join(root, 'state') };
  const configFile = join(root, 'config.json');
  const printed: string[] = [];
  const deps: PluginsDeps = {
    paths,
    configFile,
    git: runGit,
    transfer: runTransfer,
    now: () => NOW,
    print: (line) => printed.push(line),
  };
  const source = join(root, 'source');
  const commit = makeMarketplace(source, VALID_MANIFEST);
  const entry = () => readRegistry(paths).registry.marketplaces['acme'];
  const said = () => printed.join('\n');
  const leftovers = () =>
    existsSync(pluginsDir(paths)) ? readdirSync(pluginsDir(paths)).filter((name) => name.startsWith('.tmp-')) : [];
  return {
    root,
    paths,
    configFile,
    deps,
    source,
    commit,
    entry,
    said,
    printed,
    leftovers,
    dir: checkoutDir(paths, 'acme'),
  };
}

const refused = (action: () => void, reason: RegExp): void =>
  assert.throws(action, (error) => error instanceof UsageError && reason.test(error.message));

test('install registers the name, URL and full commit, pins the checkout detached at it and prints the integrations', () => {
  const fx = setup();
  pluginsInstall(fx.deps, fx.source);
  assert.deepEqual(fx.entry(), {
    url: fx.source,
    commit: fx.commit,
    installedAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  });
  assert.match(fx.commit, /^[0-9a-f]{40}$/);
  assert.equal(git(fx.dir, 'rev-parse', 'HEAD'), fx.commit);
  assert.equal(git(fx.dir, 'branch', '--show-current'), '');
  assert.match(fx.said(), new RegExp(`installed marketplace acme at ${fx.commit.slice(0, 12)} from `));
  assert.match(fx.said(), /acme:github {2}Pull requests/);
  assert.match(fx.said(), /e\.g\. acme:github/);
  assert.equal(statSync(pluginsDir(fx.paths)).mode & 0o777, 0o700);
  assert.equal(statSync(join(pluginsDir(fx.paths), 'installed.json')).mode & 0o777, 0o600);
  assert.deepEqual(fx.leftovers(), []);
});

test('install removes clones an interrupted install left more than five minutes ago, and keeps a recent one', () => {
  const fx = setup();
  mkdirSync(pluginsDir(fx.paths), { recursive: true });
  const old = join(pluginsDir(fx.paths), '.tmp-old');
  const recent = join(pluginsDir(fx.paths), '.tmp-recent');
  for (const path of [old, recent]) {
    mkdirSync(join(path, 'inner'), { recursive: true });
    writeFileSync(join(path, 'inner', 'file'), 'x');
  }
  const longAgo = new Date(NOW.getTime() - 6 * 60_000);
  utimesSync(old, longAgo, longAgo);
  utimesSync(recent, new Date(NOW.getTime() - 60_000), new Date(NOW.getTime() - 60_000));
  pluginsInstall(fx.deps, fx.source);
  assert.deepEqual(fx.leftovers(), ['.tmp-recent']);
});

test('install refuses a program that is not an executable regular file, and leaves nothing registered or behind', () => {
  const cases: [string, Record<string, FixtureFile>, RegExp][] = [
    ['not executable', { 'feeds/github/run': { content: '#!/bin/sh\n', mode: 0o644 } }, /not executable/],
    ['a symlink', { 'feeds/github/run': { link: '/bin/sh' } }, /not a link|regular file/],
    ['missing', { 'other/file': 'x' }, /not in the repository/],
  ];
  for (const [label, files, reason] of cases) {
    const fx = setup();
    const source = join(fx.root, 'bad');
    makeMarketplace(source, VALID_MANIFEST, files);
    refused(() => pluginsInstall(fx.deps, source), reason);
    assert.equal(fx.entry(), undefined, label);
    assert.deepEqual(fx.leftovers(), [], label);
    assert.equal(existsSync(fx.dir), false, label);
  }
});

test('install refuses an install URL git must never see, without cloning', () => {
  const fx = setup();
  refused(() => pluginsInstall(fx.deps, 'ext::sh -c touch /tmp/x'), /install URL/);
  assert.equal(existsSync(pluginsDir(fx.paths)), false);
});

test('install refuses a second marketplace that takes a registered name', () => {
  const fx = setup();
  pluginsInstall(fx.deps, fx.source);
  const twin = join(fx.root, 'twin');
  makeMarketplace(twin, VALID_MANIFEST);
  refused(() => pluginsInstall(fx.deps, twin), /marketplace acme is installed from .*board plugins update acme/);
  assert.equal(fx.entry()?.url, fx.source);
  assert.deepEqual(fx.leftovers(), []);
});

const PROGRAM = 'feeds/github/run';

test('verifyPin catches a moved HEAD and an edited tracked file, and lets untracked files through', () => {
  const fx = setup();
  pluginsInstall(fx.deps, fx.source);
  const pin = { name: 'acme', commit: fx.commit };
  assert.equal(verifyPin(pin, fx.dir, runGit), undefined);

  writeFileSync(join(fx.dir, '__pycache__.pyc'), 'x');
  assert.equal(verifyPin(pin, fx.dir, runGit), undefined);

  writeFileSync(join(fx.dir, PROGRAM), '#!/bin/sh\nrm -rf ~\n');
  assert.match(verifyPin(pin, fx.dir, runGit) ?? '', /local changes/);
  git(fx.dir, 'checkout', '--', '.');

  commitFiles(fx.dir, { extra: 'x' });
  assert.match(verifyPin(pin, fx.dir, runGit) ?? '', /not at its pinned commit/);
});

test('verifyPin names a missing checkout and a failing git', () => {
  const fx = setup();
  assert.match(verifyPin({ name: 'acme', commit: fx.commit }, fx.dir, runGit) ?? '', /missing/);
  pluginsInstall(fx.deps, fx.source);
  assert.match(verifyPin({ name: 'acme', commit: fx.commit }, fx.dir, () => undefined) ?? '', /git failed in /);
});

test('update moves the pin to the new commit and prints the commits it accepted', () => {
  const fx = setup();
  pluginsInstall(fx.deps, fx.source);
  const next = commitFiles(
    fx.source,
    { [PROGRAM]: { content: '#!/bin/sh\necho 2\n', mode: 0o755 } },
    'Speed up the listing',
  );
  fx.printed.length = 0;
  pluginsUpdate({ ...fx.deps, now: () => new Date('2026-12-01T00:00:00Z') }, 'acme');
  assert.equal(git(fx.dir, 'rev-parse', 'HEAD'), next);
  assert.equal(fx.entry()?.commit, next);
  assert.equal(fx.entry()?.installedAt, NOW.toISOString());
  assert.equal(fx.entry()?.updatedAt, '2026-12-01T00:00:00.000Z');
  assert.match(fx.said(), new RegExp(`acme: ${fx.commit.slice(0, 12)} → ${next.slice(0, 12)}`));
  assert.match(fx.said(), /Speed up the listing/);
});

test('update with nothing new says the pin is the latest and changes nothing', () => {
  const fx = setup();
  pluginsInstall(fx.deps, fx.source);
  const before = readFileSync(join(pluginsDir(fx.paths), 'installed.json'), 'utf8');
  fx.printed.length = 0;
  pluginsUpdate({ ...fx.deps, now: () => new Date('2027-01-01T00:00:00Z') }, 'acme');
  assert.match(fx.said(), new RegExp(`acme is at ${fx.commit.slice(0, 12)}, the latest`));
  assert.equal(readFileSync(join(pluginsDir(fx.paths), 'installed.json'), 'utf8'), before);
});

test('update refuses a marketplace that renamed itself and keeps the pin and the checkout', () => {
  const fx = setup();
  pluginsInstall(fx.deps, fx.source);
  commitFiles(fx.source, { '.agent-board/marketplace.json': JSON.stringify({ ...VALID_MANIFEST, name: 'other' }) });
  refused(() => pluginsUpdate(fx.deps, 'acme'), /now calls itself other/);
  assert.equal(fx.entry()?.commit, fx.commit);
  assert.equal(git(fx.dir, 'rev-parse', 'HEAD'), fx.commit);
});

test('update refuses a new commit whose program lost its executable bit', () => {
  const fx = setup();
  pluginsInstall(fx.deps, fx.source);
  commitFiles(fx.source, { [PROGRAM]: { content: '#!/bin/sh\n', mode: 0o644 } });
  refused(() => pluginsUpdate(fx.deps, 'acme'), /not executable.*pin stays/);
  assert.equal(fx.entry()?.commit, fx.commit);
});

test('update refuses local changes and keeps the edit', () => {
  const fx = setup();
  pluginsInstall(fx.deps, fx.source);
  commitFiles(fx.source, { extra: 'x' });
  const edited = '#!/bin/sh\necho mine\n';
  writeFileSync(join(fx.dir, PROGRAM), edited);
  refused(() => pluginsUpdate(fx.deps, 'acme'), /has local changes in .*git checkout -- \./);
  assert.equal(readFileSync(join(fx.dir, PROGRAM), 'utf8'), edited);
  assert.equal(fx.entry()?.commit, fx.commit);
});

test('update warns about a feed whose integration the new manifest dropped', () => {
  const fx = setup();
  pluginsInstall(fx.deps, fx.source);
  writeFileSync(
    fx.configFile,
    JSON.stringify({ feeds: { gh: { integration: 'acme:github' }, keep: { integration: 'acme:other' } } }),
  );
  commitFiles(fx.source, {
    '.agent-board/marketplace.json': JSON.stringify({
      ...VALID_MANIFEST,
      feeds: { other: { program: PROGRAM } },
    }),
  });
  fx.printed.length = 0;
  pluginsUpdate(fx.deps, 'acme');
  assert.match(fx.said(), /warning: feed gh names acme:github/);
  assert.doesNotMatch(fx.said(), /feed keep/);
});

test('remove refuses while a feed names the marketplace, then deletes the directory and the entry', () => {
  const fx = setup();
  pluginsInstall(fx.deps, fx.source);
  writeFileSync(
    fx.configFile,
    JSON.stringify({ feeds: { 'gh-reviews': { integration: 'acme:github' }, other: { command: 'x' } } }),
  );
  refused(() => pluginsRemove(fx.deps, 'acme'), /feeds gh-reviews use acme; remove them first/);
  assert.ok(fx.entry());
  assert.ok(existsSync(fx.dir));

  writeFileSync(fx.configFile, JSON.stringify({ feeds: {} }));
  writeFileSync(join(fx.dir, PROGRAM), 'edited');
  refused(() => pluginsRemove(fx.deps, 'acme'), /local changes/);
  assert.ok(existsSync(fx.dir));

  git(fx.dir, 'checkout', '--', '.');
  pluginsRemove(fx.deps, 'acme');
  assert.equal(fx.entry(), undefined);
  assert.equal(existsSync(fx.dir), false);
});

test('update and remove refuse a name that is not installed or not a name', () => {
  const fx = setup();
  refused(
    () => pluginsUpdate(fx.deps, 'acme'),
    /not installed, and no marketplace is installed; add one with board plugins install/,
  );
  refused(() => pluginsRemove(fx.deps, '../acme'), /not a marketplace name/);
});

test('resolveIntegration gives the program of a listed integration and says why it cannot otherwise', () => {
  const fx = setup();
  const resolve = (ref: string) => resolveIntegration(ref, { paths: fx.paths, git: runGit });
  assert.match(JSON.stringify(resolve('acme:github')), /not installed.*board plugins install/);

  pluginsInstall(fx.deps, fx.source);
  assert.deepEqual(resolve('acme:github'), { program: join(fx.dir, PROGRAM), commit: fx.commit });
  assert.deepEqual(resolve('acme:gitlab'), { problem: 'acme has no integration gitlab (it has: github)' });
  assert.match(JSON.stringify(resolve('acme:constructor')), /has no integration constructor/);
  assert.match(JSON.stringify(resolve('acme')), /<marketplace>:<integration>/);

  commitFiles(fx.dir, { extra: 'x' });
  assert.match(JSON.stringify(resolve('acme:github')), /not at its pinned commit/);
});

test('list shows the pin state, the integrations and the feeds that use them, and says when nothing is installed', () => {
  const fx = setup();
  pluginsList(fx.deps);
  assert.match(fx.said(), /no marketplaces installed/);

  pluginsInstall(fx.deps, fx.source);
  writeFileSync(fx.configFile, JSON.stringify({ feeds: { 'gh-reviews': { integration: 'acme:github' } } }));
  fx.printed.length = 0;
  pluginsList(fx.deps);
  assert.match(fx.said(), /^acme {2}.* {2}at [0-9a-f]{12} {2}installed 2026-11-23, updated 2026-11-23/);
  assert.match(fx.said(), /\n {2}ok\n {2}acme:github {3}feeds\/github\/run {3}Pull requests {3}used by gh-reviews/);

  writeFileSync(join(fx.dir, PROGRAM), 'edited');
  fx.printed.length = 0;
  pluginsList(fx.deps);
  assert.match(fx.said(), /local changes/);
});

test('list treats an unreadable registry as empty and says so', () => {
  const fx = setup();
  pluginsInstall(fx.deps, fx.source);
  writeFileSync(join(pluginsDir(fx.paths), 'installed.json'), '{nope');
  fx.printed.length = 0;
  pluginsList(fx.deps);
  assert.match(fx.said(), /unreadable \(it is not valid JSON\).*\n.*no marketplaces installed/);
  refused(() => pluginsInstall(fx.deps, fx.source), /unreadable/);
});

test('board plugins install, update and remove are refused inside a board run, and list is not', async () => {
  const fx = setup();
  const env = {
    AGENT_BOARD_STATE_DIR: fx.paths.stateDir,
    AGENT_BOARD_CONFIG_DIR: join(fx.root, 'config'),
    AGENT_BOARD_TASK: 'Ab3dEf9x',
  };
  const written: string[] = [];
  const go = (argv: string[]) =>
    runBoard(argv, { env, writeOut: (text) => written.push(text), writeErr: (text) => written.push(text) });
  await assert.rejects(go(['plugins', 'install', fx.source]), /not available inside a board run/);
  await assert.rejects(go(['plugins', 'update', 'acme']), /not available inside a board run/);
  await assert.rejects(go(['plugins', 'remove', 'acme']), /not available inside a board run/);
  assert.equal(existsSync(pluginsDir(fx.paths)), false);
  await go(['plugins', 'list']);
  assert.match(written.join(''), /no marketplaces installed/);
});
