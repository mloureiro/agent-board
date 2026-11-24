import type { Paths } from '../config/config.mts';

export interface StepContext {
  paths: Paths;
  platform: string;
  env: Record<string, string | undefined>;
  unitDir: string;
  home: string;
  signal: AbortSignal;
  print: (line: string) => void;
}

export interface StepOutcome {
  unitsChanged?: boolean;
}

export type MigrationStep =
  | {
      kind: 'auto';
      id: string;
      since: string;
      title: string;
      run: (context: StepContext) => Promise<StepOutcome | undefined>;
    }
  | {
      kind: 'person';
      id: string;
      since: string;
      title: string;
      instruction: string;
      check?: (context: StepContext) => Promise<boolean>;
    };

export const MIGRATION_BASELINE = '0.37.0';

export const MIGRATION_STEPS: readonly MigrationStep[] = [];
