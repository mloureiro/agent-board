// The update prompts a feed's requeues leave for the worker that resumes the task, in `<state dir>/feeds/updates/<task>.json`
// (mode 600, one file per task). The runner writes one before it requeues a task and the worker of the same machine reads it.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { isRecord, isSafeTaskId } from '@agent-board/shared';
import { getPaths } from '../config/config.mts';

export interface FeedUpdates {
  put: (taskId: string, prompt: string, feed: string) => void;
  read: (taskId: string) => string | undefined;
  drop: (taskId: string) => void;
}

export function createFeedUpdates(dir: string = join(getPaths().stateDir, 'feeds', 'updates')): FeedUpdates {
  const fileOf = (taskId: string): string | undefined =>
    isSafeTaskId(taskId) ? join(dir, `${taskId}.json`) : undefined;
  return {
    put: (taskId, prompt, feed) => {
      const target = fileOf(taskId);
      if (target === undefined) throw new Error(`"${taskId.slice(0, 40)}" is not a task id`);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const temp = `${target}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
      writeFileSync(temp, `${JSON.stringify({ feed, prompt })}\n`, { mode: 0o600 });
      renameSync(temp, target);
    },
    read: (taskId) => {
      const target = fileOf(taskId);
      if (target === undefined) return undefined;
      try {
        const value: unknown = JSON.parse(readFileSync(target, 'utf8'));
        return isRecord(value) && typeof value['prompt'] === 'string' && value['prompt'] !== ''
          ? value['prompt']
          : undefined;
      } catch {
        return undefined;
      }
    },
    drop: (taskId) => {
      const target = fileOf(taskId);
      if (target !== undefined) rmSync(target, { force: true });
    },
  };
}
