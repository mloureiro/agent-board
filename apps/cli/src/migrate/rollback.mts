import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isRecord } from '@agent-board/shared';
import type { Paths } from '../config/config.mts';
import { parseEnv } from '../config/env-file.mts';
import { webUrlOf } from '../backend/web-config.mts';
import { errorText } from '../output/text.mts';
import type { UpdateState } from '../self/update-state.mts';
import { AGENT_NAMES, agentFile, agentTarget } from '../setup/launchd.mts';
import type { AgentName } from '../setup/launchd.mts';
import { SystemError } from '../setup/system.mts';
import { backupsDir } from './layout.mts';
import { listBackups, markRolledBack, readBackup } from './backup.mts';
import type { BackupEntry, BackupManifest } from './backup.mts';
import { deleteJournal } from './journal.mts';
import { releaseLock, takeLock } from './lock.mts';
import { writeMarker } from './marker.mts';
import { unitFilesOf } from './units.mts';

export interface RollbackDeps {
  paths: Paths;
  platform: string;
  env: Record<string, string | undefined>;
  home: string;
  // Whether this is a released binary; a checkout has no binary of its own to restore.
  compiled: boolean;
  // Where the running binary lives: the only place a backup's binary is restored to.
  execPath: string;
  uid: number;
  now: () => Date;
  print: (line: string) => void;
  // Whether a person is at a terminal and can be asked.
  interactive: boolean;
  confirm: (message: string) => Promise<boolean>;
  // The API range the board at `url` serves, from its `version` command.
  serverRange: (url: string, token: string) => Promise<{ version: number; minClient: number }>;
  // Whether launchd has loaded the agent (macOS).
  agentLoaded: (name: AgentName) => Promise<boolean>;
  // Runs a systemctl or launchctl call that changes something.
  run: (file: string, args: string[]) => Promise<unknown>;
  // Restarts the listener and the watch unit; the line to print, if there is one.
  restart: () => Promise<string | undefined>;
  updateState: UpdateState;
}

interface Restore {
  stored: string;
  dest: string;
  content: Buffer;
  mode: number;
}

const refuse = (message: string): SystemError => new SystemError(`${message}; nothing was changed`);

function newestBackup(stateDir: string): BackupEntry {
  const root = backupsDir(stateDir);
  const rootInfo = lstatSync(root, { throwIfNoEntry: false });
  if (rootInfo === undefined) throw refuse(`there is no backup to roll back to (${root} does not exist)`);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw refuse(`${root} is not a plain directory`);
  const newest = listBackups(stateDir)[0];
  if (newest === undefined) throw refuse(`there is no backup to roll back to in ${root}`);
  if (newest.manifest.rolledBackAt !== null)
    throw refuse(
      `nothing to roll back: the newest backup ${newest.dir} was rolled back at ${newest.manifest.rolledBackAt}`,
    );
  const info = lstatSync(newest.dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw refuse(`${newest.dir} is not a plain directory`);
  return newest;
}

// A path a restore may write: the file name is one component, and the manifest's recorded directory is this machine's own.
function destinationOf(deps: RollbackDeps, stored: string): string | undefined {
  const [area, name] = stored.split('/');
  const units = unitFilesOf(deps.platform, deps.env, deps.home);
  if (name === undefined || name === '.' || name === '..') return undefined;
  if (area === 'config') return join(deps.paths.configDir, name);
  if (area === 'units' && units.names.includes(name)) return join(units.dir, name);
  return undefined;
}

function plannedRestores(deps: RollbackDeps, manifest: BackupManifest, contents: Map<string, Buffer>): Restore[] {
  const restores: Restore[] = [];
  for (const file of manifest.files) {
    if (file.path === 'board') continue;
    const dest = destinationOf(deps, file.path);
    const content = contents.get(file.path);
    if (dest === undefined || content === undefined)
      throw refuse(`the backup lists ${file.path}, which a rollback does not restore`);
    restores.push({ stored: file.path, dest, content, mode: file.mode });
  }
  return restores;
}

function currentContent(dest: string): Buffer | undefined {
  const info = lstatSync(dest, { throwIfNoEntry: false });
  if (info === undefined) return undefined;
  if (info.isSymbolicLink()) throw refuse(`${dest} is a symlink, which a rollback does not follow or replace`);
  if (!info.isFile()) throw refuse(`${dest} is not a regular file`);
  return readFileSync(dest);
}

// Written beside its place with its final mode and renamed over it; an unpredictable name made exclusively, so nobody who can
// write that directory can plant it first.
function stage(dest: string, content: Buffer, mode: number): string {
  const temp = join(dirname(dest), `.${basename(dest)}.rollback-${randomBytes(8).toString('hex')}`);
  writeFileSync(temp, content, { flag: 'wx', mode });
  chmodSync(temp, mode);
  return temp;
}

async function serverCheck(
  deps: RollbackDeps,
  manifest: BackupManifest,
  contents: Map<string, Buffer>,
): Promise<string> {
  const web = contents.get('config/web.json');
  const env = contents.get('config/env');
  if (web === undefined || env === undefined)
    throw refuse(
      'the backup holds no web.json or no env, so the board cannot be asked whether it still serves the old CLI',
    );
  let url: string;
  try {
    const raw: unknown = JSON.parse(web.toString('utf8'));
    url = webUrlOf(isRecord(raw) ? raw : {});
  } catch (error) {
    throw refuse(`the web.json in the backup does not name a board (${errorText(error)})`);
  }
  const token = parseEnv(env.toString('utf8'))['AGENT_BOARD_TOKEN'];
  if (token === undefined || token === '') throw refuse('the env in the backup holds no AGENT_BOARD_TOKEN');
  let range: { version: number; minClient: number };
  try {
    range = await deps.serverRange(url, token);
  } catch (error) {
    throw refuse(`cannot check whether the board at ${url} still serves CLI ${manifest.from} (${errorText(error)})`);
  }
  if (manifest.cliApi < range.minClient)
    throw refuse(
      `the board at ${url} no longer serves CLI ${manifest.from} (API ${manifest.cliApi}, it serves from ${range.minClient})`,
    );
  return url;
}

async function reloadMacAgents(deps: RollbackDeps, reload: AgentName[]): Promise<void> {
  for (const name of reload) {
    await deps.run('launchctl', ['bootout', agentTarget(deps.uid, name)]).catch(() => undefined);
    await deps.run('launchctl', [
      'bootstrap',
      `gui/${deps.uid}`,
      join(unitFilesOf(deps.platform, deps.env, deps.home).dir, agentFile(name)),
    ]);
  }
}

// `board self-update --rollback`: put the config, the unit files and the binary back as the newest backup holds them.
export async function rollback(deps: RollbackDeps): Promise<'rolled-back' | 'declined'> {
  const { stateDir } = deps.paths;
  takeLock(stateDir, { adoptParent: false });
  try {
    const entry = newestBackup(stateDir);
    const read = readBackup(entry.dir);
    if (!read.ok) throw refuse(`the backup ${entry.dir} cannot be trusted: ${read.problem}`);
    const { manifest, contents } = read;
    if (manifest.kind !== 'update')
      throw refuse(
        `the newest backup ${entry.dir} has no binary (kind ${manifest.kind}); restoring the config alone would make the next tick run the same steps again; restore its files by hand if you need them`,
      );
    if (!deps.compiled) throw refuse('this board runs from a checkout, so there is no installed binary to restore');
    if (manifest.platform !== deps.platform || manifest.binaryPath !== deps.execPath)
      throw refuse(
        `the backup ${entry.dir} was made for ${manifest.binaryPath ?? 'no binary'} on ${manifest.platform}, not for ${deps.execPath} on ${deps.platform}`,
      );
    if (
      manifest.configDir !== deps.paths.configDir ||
      manifest.unitDir !== unitFilesOf(deps.platform, deps.env, deps.home).dir
    )
      throw refuse(`the backup ${entry.dir} was made for other config or unit directories than this machine uses`);
    const binary = contents.get('board');
    if (binary === undefined) throw refuse(`the backup ${entry.dir} holds no binary`);

    const restores = plannedRestores(deps, manifest, contents);
    const changed = restores.filter((restore) => {
      const current = currentContent(restore.dest);
      return current === undefined || !current.equals(restore.content);
    });
    const binaryInfo = lstatSync(deps.execPath, { throwIfNoEntry: false });
    if (binaryInfo?.isSymbolicLink() === true)
      throw refuse(`${deps.execPath} is a symlink, which a rollback does not follow or replace`);

    const url = await serverCheck(deps, manifest, contents);
    deps.print(
      `checked the backup ${entry.dir} (every file matches its checksum) and ${url} (it still serves CLI ${manifest.from})`,
    );
    deps.print(`rolling back board ${manifest.to} -> ${manifest.from}:`);
    deps.print(`  binary ${deps.execPath}`);
    for (const restore of changed) deps.print(`  ${restore.dest}`);
    if (deps.interactive && !(await deps.confirm('Do you want to roll back? (Server data is not rolled back.)'))) {
      deps.print('nothing changed');
      return 'declined';
    }

    const macAgents: AgentName[] = [];
    if (deps.platform === 'darwin')
      for (const restore of changed) {
        const name = AGENT_NAMES.find((agent) => agentFile(agent) === basename(restore.dest));
        if (restore.stored.startsWith('units/') && name !== undefined && (await deps.agentLoaded(name)))
          macAgents.push(name);
      }

    const stagedBinary = stage(deps.execPath, binary, 0o755);
    try {
      for (const restore of changed) {
        mkdirSync(dirname(restore.dest), { recursive: true });
        const staged = stage(restore.dest, restore.content, restore.mode);
        try {
          renameSync(staged, restore.dest);
        } finally {
          rmSync(staged, { force: true });
        }
      }
      renameSync(stagedBinary, deps.execPath);
    } finally {
      rmSync(stagedBinary, { force: true });
    }
    const unitsChanged = changed.some((restore) => restore.stored.startsWith('units/'));
    if (unitsChanged && deps.platform === 'linux') await deps.run('systemctl', ['--user', 'daemon-reload']);
    await reloadMacAgents(deps, macAgents);

    writeMarker(stateDir, manifest.from);
    deleteJournal(stateDir);
    markRolledBack(entry.dir, manifest, deps.now());
    deps.updateState.holdThrough(manifest.to);
    const restarted = await deps.restart();
    if (restarted !== undefined) deps.print(restarted);
    deps.print(
      `rolled back to board ${manifest.from}; auto-update holds release ${manifest.to} and older until you run "board self-update"`,
    );
    return 'rolled-back';
  } finally {
    releaseLock(stateDir);
  }
}
