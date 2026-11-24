import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { ReportedFailure } from '../cli.mts';
import { AGENT_NAMES, agentFile, agentTarget } from './launchd.mts';
import { LONG_RUNNING_SERVICES, REMOVED_UNIT_FILES, renderUnits } from './setup.mts';
import type { SetupDeps } from './setup.mts';
import { SystemError } from './system.mts';

export interface UninstallFlags {
  includeOptional?: boolean;
  dryRun?: boolean;
}

export interface UninstallDeps {
  setup: SetupDeps;
  installedBoard: string;
  optionalDirs: string[];
}

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

interface Stopped {
  removable: string[];
  failed: boolean;
}

async function stopUnits(deps: SetupDeps, dryRun: boolean): Promise<Stopped> {
  const removable: string[] = [];
  let failed = false;
  const stop = async (file: string, program: string, args: string[]): Promise<void> => {
    if (dryRun) {
      deps.print(`DRY ${program} ${args.join(' ')}`);
      removable.push(file);
      return;
    }
    try {
      await deps.run(program, args);
      removable.push(file);
    } catch (error) {
      failed = true;
      const reason = error instanceof Error ? error.message : String(error);
      deps.print(
        `could not stop ${basename(file)}: ${reason}; its file is kept, stop it by hand and run board uninstall again`,
      );
    }
  };
  if (deps.platform === 'darwin') {
    for (const name of AGENT_NAMES) {
      const file = join(deps.launchd.agentsDir, agentFile(name));
      if (await deps.launchd.loaded(name))
        await stop(file, 'launchctl', ['bootout', agentTarget(deps.launchd.uid, name)]);
      else removable.push(file);
    }
    return { removable, failed };
  }
  const files = [...renderUnits({ flock: 'flock', command: () => [] }).map((unit) => unit.file), ...REMOVED_UNIT_FILES];
  const installed = files.filter((file) => present(join(deps.unitDir, file)));
  // One call per unit: systemctl fails the whole call on a unit it does not know.
  for (const unit of installed.filter((file) => file.endsWith('.timer') || LONG_RUNNING_SERVICES.includes(file)))
    await stop(join(deps.unitDir, unit), 'systemctl', ['--user', 'disable', '--now', unit]);
  for (const unit of installed.filter((file) => file.endsWith('.service') && !LONG_RUNNING_SERVICES.includes(file)))
    await stop(join(deps.unitDir, unit), 'systemctl', ['--user', 'stop', unit]);
  return { removable, failed };
}

function resolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function coversHome(dir: string, home: string): boolean {
  const toHome = relative(resolved(dir), resolved(home));
  return toHome === '' || (!toHome.startsWith('..') && !isAbsolute(toHome));
}

export async function uninstall(deps: UninstallDeps, flags: UninstallFlags): Promise<void> {
  const { setup } = deps;
  if (setup.platform !== 'darwin' && setup.platform !== 'linux')
    throw new SystemError(`board uninstall needs Linux with systemd or macOS; this is ${setup.platform}`);
  const dryRun = flags.dryRun === true;
  const remove = (path: string, recursive: boolean): void => {
    if (!present(path)) return;
    if (dryRun) return setup.print(`DRY remove ${path}`);
    rmSync(path, { recursive, force: true });
    setup.print(`removed ${path}`);
  };
  const stopped = await stopUnits(setup, dryRun);
  let failed = stopped.failed;
  for (const file of stopped.removable) remove(file, false);
  if (setup.platform === 'linux') {
    if (dryRun) setup.print('DRY systemctl --user daemon-reload');
    else await setup.run('systemctl', ['--user', 'daemon-reload']).catch(() => undefined);
  }
  if (stopped.failed) setup.print(`kept ${deps.installedBoard} so board uninstall can be run again`);
  else remove(deps.installedBoard, false);
  if (flags.includeOptional) {
    for (const dir of deps.optionalDirs) {
      if (present(dir) && coversHome(dir, setup.launchd.home)) {
        failed = true;
        setup.print(`refused to remove ${dir}: it is the home directory or a directory that holds it`);
      } else remove(dir, true);
    }
  } else {
    const kept = deps.optionalDirs.filter((dir) => existsSync(dir));
    if (kept.length > 0)
      setup.print(
        `kept ${kept.join(', ')}: the config (with the token and the data key), task logs and sessions; add --include-optional to remove them too`,
      );
  }
  setup.print('Workers that are running keep running until they end.');
  if (failed) throw new ReportedFailure('board uninstall did not finish');
}
