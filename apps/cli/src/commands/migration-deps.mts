import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { API_VERSION } from '@agent-board/shared';
import { getPaths } from '../config/config.mts';
import { releaseOf } from '../migrate/deps.mts';
import type { MigrationDeps } from '../migrate/deps.mts';
import { MIGRATION_STEPS } from '../migrate/steps.mts';
import { realListenerRestart } from '../self/self-update.mts';
import { cliVersion } from '../self/version.mts';
import { clackPrompts } from '../setup/init.mts';
import type { ProgramShared } from './program-shared.mts';

const execFileAsync = promisify(execFile);

export function realMigrationDeps({
  options,
  env,
  out,
}: Pick<ProgramShared, 'options' | 'env' | 'out'>): MigrationDeps {
  const platform = options.platform ?? process.platform;
  return {
    registry: options.migrationSteps ?? MIGRATION_STEPS,
    version: releaseOf(options.version ?? cliVersion()),
    paths: getPaths(env),
    platform,
    env,
    home: options.home ?? (env['HOME'] || homedir()),
    cliApi: API_VERSION,
    now: options.now ?? (() => new Date()),
    print: out,
    confirm: async (message) => (await (options.prompts ?? clackPrompts()).confirm?.(message)) === true,
    restart: options.restartListener ?? realListenerRestart({ block: true, platform }),
    run: options.runSystem ?? ((file, args) => execFileAsync(file, args)),
  };
}
