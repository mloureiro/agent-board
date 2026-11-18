import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeRunFiles } from '../__tests__/helpers/fakes.mts';
import { shutdownWorkers } from './shutdown.mts';
import type { System } from './system.mts';

// Workers end on their own `after` polls (counted by activeWorkers calls) after the signal; the others never do.
function harness(input: {
  active: string[];
  endsAfterPolls: Record<string, number>;
  failSignal?: string[];
  goneAtSignal?: string[];
}) {
  let clock = 0;
  const signalled: string[] = [];
  const stopped: string[] = [];
  const printed: string[] = [];
  const polls: Record<string, number> = {};
  const gone = new Set<string>();
  const vanished = new Set(input.goneAtSignal);
  const system: System = {
    async isActive(unit) {
      const id = unit.replace('agent-board-', '');
      return !gone.has(id) && !vanished.has(id);
    },
    async startedAt() {
      return undefined;
    },
    async activeWorkers() {
      return input.active.filter((id) => {
        if (gone.has(id)) return false;
        if (signalled.includes(`agent-board-${id}`) && id in input.endsAfterPolls) {
          polls[id] = (polls[id] ?? 0) + 1;
          if (polls[id]! > input.endsAfterPolls[id]!) {
            gone.add(id);
            return false;
          }
        }
        return true;
      });
    },
    async stop(unit) {
      stopped.push(unit);
      gone.add(unit.replace('agent-board-', ''));
    },
    async signalWorker(unit, signal) {
      assert.equal(signal, 'SIGUSR2');
      if (input.failSignal?.includes(unit.replace('agent-board-', ''))) throw new Error('no such process');
      signalled.push(unit);
    },
    async startWorker() {
      return { pid: undefined };
    },
  };
  const files = fakeRunFiles();
  const run = (graceMs: number) =>
    shutdownWorkers({
      system,
      files,
      print: (line) => void printed.push(line),
      now: () => new Date(clock),
      sleep: async (ms) => void (clock += ms),
      graceMs,
      pollMs: 1000,
    });
  return { run, files, signalled, stopped, printed };
}

test('every active worker gets its deadline file and SIGUSR2; the ones that end are paused, the rest are stopped', async () => {
  const { run, files, signalled, stopped, printed } = harness({
    active: ['aaaa1111', 'bbbb2222'],
    endsAfterPolls: { aaaa1111: 2 },
  });
  await run(20_000);
  assert.deepEqual(signalled, ['agent-board-aaaa1111', 'agent-board-bbbb2222']);
  assert.deepEqual(stopped, ['agent-board-bbbb2222']);
  assert.deepEqual(printed.sort(), ['aaaa1111 paused', 'bbbb2222 stopped']);
  assert.deepEqual(files.shutdownDeadline('aaaa1111'), new Date(15_000));
});

test('a worker that cannot be signalled is gone and is not waited for or stopped', async () => {
  const { run, stopped, printed } = harness({
    active: ['cccc3333'],
    endsAfterPolls: {},
    failSignal: ['cccc3333'],
  });
  await run(20_000);
  assert.deepEqual(stopped, []);
  assert.deepEqual(printed, ['cccc3333 gone']);
});

test('a worker that ended between the listing and the signal is gone and gets no signal', async () => {
  const { run, signalled, printed } = harness({ active: ['ffff6666'], endsAfterPolls: {}, goneAtSignal: ['ffff6666'] });
  await run(20_000);
  assert.deepEqual(signalled, []);
  assert.deepEqual(printed, ['ffff6666 gone']);
});

test('with no worker running it prints nothing and does not wait', async () => {
  const { run, signalled, printed } = harness({ active: [], endsAfterPolls: {} });
  await run(20_000);
  assert.deepEqual(signalled, []);
  assert.deepEqual(printed, []);
});

test('a short grace leaves the worker half of it, and no more than 5 s, for the pause report', async () => {
  const short = harness({ active: ['dddd4444'], endsAfterPolls: { dddd4444: 0 } });
  await short.run(5_000);
  assert.deepEqual(short.files.shutdownDeadline('dddd4444'), new Date(2_500));
  const long = harness({ active: ['eeee5555'], endsAfterPolls: { eeee5555: 0 } });
  await long.run(60_000);
  assert.deepEqual(long.files.shutdownDeadline('eeee5555'), new Date(55_000));
});
