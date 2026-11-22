import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isRecord, MAX_CONTEXT_TOKENS } from '@agent-board/shared';

const MAX_MODELS = 64;
const MODEL_ID = /^[A-Za-z0-9._:@[\]/-]{1,128}$/;

export interface ContextWindowStore {
  read: () => Record<string, number>;
  record: (windows: Record<string, number>) => void;
}

export function contextWindowsFile(stateDir: string): string {
  return join(stateDir, 'context-windows.json');
}

function validWindows(raw: unknown): Record<string, number> {
  const windows: Record<string, number> = {};
  if (!isRecord(raw)) return windows;
  for (const [model, window] of Object.entries(raw)) {
    if (!MODEL_ID.test(model)) continue;
    if (typeof window === 'number' && Number.isInteger(window) && window >= 1 && window <= MAX_CONTEXT_TOKENS)
      windows[model] = window;
  }
  return windows;
}

export function createContextWindowStore(file: string): ContextWindowStore {
  const read = (): Record<string, number> => {
    try {
      return validWindows(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      return {};
    }
  };
  return {
    read,
    record(windows) {
      const fresh = validWindows(windows);
      const stored = read();
      const kept = Object.entries(stored).filter(([model]) => !(model in fresh));
      const merged = Object.fromEntries([...Object.entries(fresh), ...kept].slice(0, MAX_MODELS));
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        writeFileSync(temp, `${JSON.stringify(merged)}\n`, { mode: 0o600 });
        renameSync(temp, file);
      } catch (error) {
        rmSync(temp, { force: true });
        throw error;
      }
    },
  };
}
