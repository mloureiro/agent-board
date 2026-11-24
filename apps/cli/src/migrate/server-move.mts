import { lstatSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '@agent-board/shared';
import type { ListedMachine } from '@agent-board/shared';
import { UsageError } from '../cli.mts';
import { BackendError } from '../backend/backend.mts';
import { checkDataKey } from '../backend/contract-check.mts';
import type { ServerIdentity } from '../backend/contract-check.mts';
import { checkBoardUrl, loadWebConfig } from '../backend/web-config.mts';
import type { WebConfig } from '../backend/web-config.mts';
import { forgetAppliedVersion } from '../config/board-agents.mts';
import { boardAgentsDirOf, readBoardAgentsState } from '../config/config.mts';
import { errorText } from '../output/text.mts';
import { SystemError } from '../setup/system.mts';
import { createBackup } from './backup.mts';
import type { MigrationDeps } from './deps.mts';
import { readJournal } from './journal.mts';
import { stageFile } from './layout.mts';
import { releaseLock, takeLock } from './lock.mts';
import { unitFilesOf } from './units.mts';

export interface ServerMoveDeps extends Pick<
  MigrationDeps,
  'paths' | 'platform' | 'env' | 'home' | 'version' | 'cliApi' | 'now' | 'print' | 'confirm' | 'restart'
> {
  // Whether a person is at a terminal and can be asked.
  interactive: boolean;
  activeWorkers: () => Promise<number>;
  // What the board at `config.url` says of itself, as `verifyContract` returns it.
  verify: (config: Pick<WebConfig, 'url' | 'token'>) => Promise<ServerIdentity>;
  listMachines: (config: Pick<WebConfig, 'url' | 'token'>) => Promise<ListedMachine[]>;
}

const ACTIVE_WITHIN_MS = 15 * 60 * 1000;
const IMPORT_FIRST = 'import your board export there first (Settings › Account › Your data), then run this again';

const refuse = (message: string): SystemError => new SystemError(`${message}; nothing was changed`);

function canonical(url: URL): string {
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function targetUrlOf(raw: string): string {
  const fail = (problem: string): UsageError => new UsageError(`--server ${problem}`);
  if (/[?#]/.test(raw)) throw fail("must be the board's URL without a query or a fragment");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw fail("must be the board's http(s) URL");
  }
  if (parsed.username !== '' || parsed.password !== '') throw fail('must not hold a user name or a password');
  try {
    return checkBoardUrl(canonical(parsed));
  } catch (error) {
    throw fail(errorText(error).replace(/^web\.json: url /, ''));
  }
}

function targetProblem(url: string, error: unknown): SystemError {
  if (error instanceof BackendError && (error.status === 401 || error.status === 403))
    return refuse(`${url} does not accept this machine's token: ${IMPORT_FIRST}`);
  return refuse(errorText(error));
}

async function otherMachines(
  deps: ServerMoveDeps,
  source: WebConfig,
  identity: ServerIdentity | undefined,
): Promise<{ active: string[] } | { unknown: string }> {
  if (identity === undefined) return { unknown: `${source.url} cannot be reached` };
  if (!identity.features.has('machine.list')) return { unknown: `${source.url} cannot list its machines` };
  let machines: ListedMachine[];
  try {
    machines = await deps.listMachines(source);
  } catch (error) {
    return { unknown: errorText(error) };
  }
  const now = deps.now().getTime();
  return {
    active: machines
      .filter(
        (machine) =>
          !machine.current && machine.lastSeenAt !== null && now - Date.parse(machine.lastSeenAt) <= ACTIVE_WITHIN_MS,
      )
      .map((machine) => machine.name),
  };
}

// What on this machine was derived from the source board and means something else on the target. Everything else the state
// directory holds (waits, watches, feed records, the PR and usage readings, the catalogue, the update hints) is keyed by task
// ids, which an import keeps, or by this machine alone; the feeds and the directory list are re-sent when the target's index
// differs from theirs.
function resetServerDerivedState(deps: ServerMoveDeps, target: ServerIdentity): string[] {
  const { configFile } = deps.paths;
  const applied = readBoardAgentsState(boardAgentsDirOf(configFile)).version;
  if (applied === null || target.agentsVersion === undefined || target.agentsVersion >= applied) return [];
  try {
    forgetAppliedVersion(configFile);
  } catch (error) {
    return [
      `could not reset the shared agents version (${errorText(error)}); until the target names a version above v${applied} this machine keeps its agents`,
    ];
  }
  return [
    `the target holds shared agents v${target.agentsVersion}, below v${applied} applied here: the next tick applies its agents`,
  ];
}

function stageWebJson(path: string, url: string): string {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info === undefined || !info.isFile())
    throw refuse(`${path} is not a regular file, and a symlink is not replaced; edit its url by hand`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw refuse(`${path} is not valid JSON (${errorText(error)})`);
  }
  if (!isRecord(raw)) throw refuse(`${path} is not a JSON object`);
  try {
    return stageFile(path, `${JSON.stringify({ ...raw, url }, null, 2)}\n`, info.mode & 0o777, 'move');
  } catch (error) {
    throw refuse(`cannot write beside ${path} (${errorText(error)})`);
  }
}

export async function moveServer(deps: ServerMoveDeps, rawUrl: string): Promise<'moved' | 'declined' | 'unchanged'> {
  const { configDir, stateDir } = deps.paths;
  if (!deps.interactive)
    throw refuse('--server needs a terminal: it asks before it repoints this machine, and tells you about the others');
  const target = targetUrlOf(rawUrl);
  const source = loadWebConfig(configDir);
  if (canonical(new URL(source.url)) === target) {
    deps.print(`this machine already uses ${target}`);
    return 'unchanged';
  }
  if (readJournal(stateDir) !== undefined)
    throw refuse('a migration is unfinished; run "board self-update --resume" first');

  let identity: ServerIdentity;
  try {
    identity = await deps.verify({ url: target, token: source.token });
  } catch (error) {
    throw targetProblem(target, error);
  }
  let sourceIdentity: ServerIdentity | undefined;
  let sourceProblem = '';
  try {
    sourceIdentity = await deps.verify(source);
  } catch (error) {
    sourceProblem = errorText(error);
  }
  if (sourceIdentity !== undefined && sourceIdentity.owner !== identity.owner)
    throw refuse(
      `${target} signs you in as ${identity.owner}, but the board at ${source.url} belongs to ${sourceIdentity.owner}`,
    );
  const key = await checkDataKey(source.dataKey, identity);
  if ('problem' in key)
    throw refuse(
      key.problem === 'board-has-no-key'
        ? `${target} holds no data key yet: ${IMPORT_FIRST}`
        : `${target} holds another board (key id ${key.boards}, this machine's key id ${key.mine})`,
    );
  deps.print(
    `checked ${target}: it accepts this machine's token and holds the board of ${identity.owner} (key id ${key.keys.keyId})`,
  );

  const running = await deps.activeWorkers();
  if (running > 0) throw refuse(`${running} worker(s) running; run board self-update --server again once they end`);

  const others = await otherMachines(deps, source, sourceIdentity);
  if ('active' in others && others.active.length > 0)
    deps.print(
      `${source.url} still lists ${others.active.length} other machine(s) seen in the last 15 minutes: ${others.active.join(', ')}; they keep claiming tasks there until each runs "board self-update --server ${target}"`,
    );
  if ('unknown' in others)
    deps.print(
      `cannot tell whether other machines still use ${source.url} (${others.unknown}); run "board self-update --server ${target}" on each of them`,
    );
  if (sourceProblem !== '') deps.print(`${source.url} did not answer (${sourceProblem}); it is left as it is`);
  if (!(await deps.confirm(`Point this machine at ${target}? (${source.url} is not changed.)`))) {
    deps.print('nothing changed');
    return 'declined';
  }

  takeLock(stateDir, { adoptParent: false });
  let staged: string | undefined;
  try {
    if (readJournal(stateDir) !== undefined)
      throw refuse('a migration is unfinished; run "board self-update --resume" first');
    const webPath = join(configDir, 'web.json');
    staged = stageWebJson(webPath, target);
    let backupDir: string;
    try {
      backupDir = createBackup({
        stateDir,
        kind: 'server',
        from: deps.version,
        to: deps.version,
        cliApi: deps.cliApi,
        configDir,
        unitFiles: unitFilesOf(deps.platform, deps.env, deps.home),
        platform: deps.platform,
        now: deps.now(),
      }).dir;
    } catch (error) {
      throw refuse(`cannot back up this machine (${errorText(error)})`);
    }
    try {
      renameSync(staged, webPath);
    } catch (error) {
      throw refuse(`cannot replace ${webPath} (${errorText(error)}); the backup is at ${backupDir}`);
    }
    deps.print(`this machine now points at ${target}; the backup is at ${backupDir}`);
    for (const line of resetServerDerivedState(deps, identity)) deps.print(line);
    const restarted = await deps.restart();
    if (restarted !== undefined) deps.print(restarted);
    try {
      await deps.verify(loadWebConfig(configDir));
    } catch (error) {
      throw new SystemError(
        `the check against ${target} after the move failed (${errorText(error)}); this machine points at it now; "board self-update --server ${source.url}" points it back, and the backup is at ${backupDir}`,
      );
    }
    deps.print(`${source.url} is unchanged; the feeds, the worker and its units now talk to ${target}`);
    deps.print(`to go back to ${source.url}: board self-update --server ${source.url}`);
    return 'moved';
  } finally {
    if (staged !== undefined) rmSync(staged, { force: true });
    releaseLock(stateDir);
  }
}
