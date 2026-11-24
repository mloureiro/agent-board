import type { Paths } from '../config/config.mts';
import type { MigrationStep, StepContext } from './steps.mts';
import { unitFilesOf } from './units.mts';

export interface MigrationDeps {
  registry: readonly MigrationStep[];
  // The version of this CLI, as x.y.z.
  version: string;
  paths: Paths;
  platform: string;
  env: Record<string, string | undefined>;
  home: string;
  // API_VERSION of this CLI, recorded in a backup so a restore can check the server still serves it.
  cliApi: number;
  now: () => Date;
  print: (line: string) => void;
  confirm: (message: string) => Promise<boolean>;
  // Restarts the listener and the watch unit; the line to print, if there is one.
  restart: () => Promise<string | undefined>;
  // Runs a systemctl call that changes something.
  run: (file: string, args: string[]) => Promise<unknown>;
}

export function stepContext(deps: MigrationDeps, signal: AbortSignal): StepContext {
  return {
    paths: deps.paths,
    platform: deps.platform,
    env: deps.env,
    unitDir: unitFilesOf(deps.platform, deps.env, deps.home).dir,
    home: deps.home,
    signal,
    print: deps.print,
  };
}

// A checkout reports x.y.z-dev; its steps are those of x.y.z.
export const releaseOf = (version: string): string => version.replace(/-dev$/, '');
