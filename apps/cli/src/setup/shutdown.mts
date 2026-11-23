import { unitName } from '../task-id.mts';
import type { RunFiles } from '../worker/runtime.mts';
import type { System } from './system.mts';

export const DEFAULT_SHUTDOWN_GRACE_S = 20;
const POLL_MS = 250;
const REPORT_RESERVE_MS = 5_000;

export interface ShutdownDeps {
  system: System;
  files: RunFiles;
  print: (line: string) => void;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  graceMs: number;
  pollMs?: number;
}

type Result = 'paused' | 'stopped' | 'gone';

export async function shutdownWorkers(deps: ShutdownDeps): Promise<void> {
  const { system, files, print, now, sleep, graceMs } = deps;
  const started = now().getTime();
  const workerDeadline = new Date(started + graceMs - Math.min(REPORT_RESERVE_MS, graceMs / 2));
  const results = new Map<string, Result>();
  const waiting = new Set<string>();
  for (const taskId of await system.activeWorkers()) {
    const unit = unitName(taskId);
    try {
      if (!(await system.isActive(unit))) {
        results.set(taskId, 'gone');
        continue;
      }
      files.requestShutdown(taskId, workerDeadline);
      await system.signalWorker(unit, 'SIGUSR2');
      waiting.add(taskId);
    } catch {
      results.set(taskId, 'gone');
    }
  }
  const stillActive = async (): Promise<string[]> => {
    const active = new Set(await system.activeWorkers());
    return [...waiting].filter((taskId) => active.has(taskId));
  };
  let remaining = await stillActive();
  while (remaining.length > 0 && now().getTime() - started < graceMs) {
    await sleep(deps.pollMs ?? POLL_MS);
    remaining = await stillActive();
  }
  for (const taskId of waiting) {
    if (!remaining.includes(taskId)) results.set(taskId, 'paused');
  }
  for (const taskId of remaining) {
    await system.stop(unitName(taskId));
    results.set(taskId, 'stopped');
  }
  for (const [taskId, result] of results) print(`${taskId} ${result}`);
}
