import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPaths } from '../../config/config.mts';
import type { MigrationDeps } from '../../migrate/deps.mts';
import type { MigrationStep, StepContext, StepOutcome } from '../../migrate/steps.mts';

export interface Fixture {
  dir: string;
  deps: MigrationDeps;
  printed: string[];
  restarts: number;
  runs: string[][];
  answers: boolean[];
  clock: { now: Date };
}

export function fixture(registry: readonly MigrationStep[], overrides: Partial<MigrationDeps> = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'board-migrate-test-'));
  const env = {
    AGENT_BOARD_CONFIG_DIR: join(dir, 'config'),
    AGENT_BOARD_STATE_DIR: join(dir, 'state'),
    XDG_CONFIG_HOME: join(dir, 'xdg'),
  };
  mkdirSync(env.AGENT_BOARD_CONFIG_DIR, { recursive: true });
  writeFileSync(join(env.AGENT_BOARD_CONFIG_DIR, 'web.json'), '{"url":"https://board.example.com"}\n');
  writeFileSync(join(env.AGENT_BOARD_CONFIG_DIR, 'env'), 'AGENT_BOARD_TOKEN=abm_x\n', { mode: 0o600 });
  const result: Fixture = {
    dir,
    printed: [],
    restarts: 0,
    runs: [],
    answers: [],
    clock: { now: new Date('2026-11-24T10:15:03.000Z') },
    deps: undefined as unknown as MigrationDeps,
  };
  result.deps = {
    registry,
    version: '0.40.0',
    paths: getPaths(env),
    platform: 'linux',
    env,
    home: dir,
    cliApi: 9,
    now: () => result.clock.now,
    print: (line) => result.printed.push(line),
    confirm: async () => result.answers.shift() ?? false,
    restart: async () => {
      result.restarts += 1;
      return 'restarted the listener';
    },
    run: async (file, args) => {
      result.runs.push([file, ...args]);
    },
    ...overrides,
  };
  return result;
}

export function autoStep(
  id: string,
  since: string,
  run: (context: StepContext) => Promise<StepOutcome | undefined> = async () => undefined,
): MigrationStep {
  return { kind: 'auto', id, since, title: `title of ${id}`, run };
}

export function personStep(
  id: string,
  since: string,
  check?: (context: StepContext) => Promise<boolean>,
): MigrationStep {
  return {
    kind: 'person',
    id,
    since,
    title: `title of ${id}`,
    instruction: `do ${id} by hand`,
    ...(check === undefined ? {} : { check }),
  };
}
