import { Command } from 'commander';
import { REMOVED_INTAKE } from '../config/config.mts';
import { UsageError } from '../cli.mts';
import { runDir } from '../worker/runtime.mts';
import { dispatchMain } from '../dispatch/dispatch.mts';
import { SystemError } from '../setup/system.mts';
import { currentPlan } from '../migrate/pending.mts';
import { runHook } from '../worker/hook.mts';
import { listenMain } from '../dispatch/listen.mts';
import { watchUnitMain } from '../watch/unit.mts';
import { workerMain } from '../worker/worker.mts';
import { realMigrationDeps } from './migration-deps.mts';
import type { ProgramShared } from './program-shared.mts';

export function registerInternalCommands(shared: ProgramShared): void {
  const { program, options, env, out, contextOf, dryRunOption, notInRun, writeJson, jsonOption } = shared;
  const internal = program
    .command('internal', { hidden: true })
    .description('What the dispatcher, the timers and a run call; not for typing')
    .action(() => {
      throw new UsageError('internal needs dispatch, listen, watch, worker, hook or migration-plan');
    });
  const refuseInternalInRun = (): void => {
    notInRun('board internal is not available inside a board run');
    const platform = options.platform ?? process.platform;
    if (platform !== 'linux' && platform !== 'darwin')
      throw new SystemError(
        `board internal runs worker machines and needs Linux with systemd or macOS; this is ${platform}`,
      );
  };
  dryRunOption(internal.command('dispatch').description('One dispatcher tick')).action((_options, command: Command) => {
    refuseInternalInRun();
    return dispatchMain({ dryRun: contextOf(command).dryRun });
  });
  // The timer of the removed intake that `board setup` has not deleted yet still runs this: a quiet success, not a failing unit.
  internal
    .command('intake', { hidden: true })
    .description('Removed')
    .action(() => {
      out(`${REMOVED_INTAKE}; run "board setup" to delete this timer`);
    });
  internal
    .command('listen')
    .description('Run a dispatch tick when the board says tasks changed')
    .action(() => {
      refuseInternalInRun();
      return listenMain();
    });
  internal
    .command('watch')
    .description('Run the watch unit: look at the watches of this machine and wake their tasks')
    .action(() => {
      refuseInternalInRun();
      return watchUnitMain();
    });
  internal
    .command('worker')
    .description('Run one task')
    .argument('<task>')
    .action((task: string) => {
      refuseInternalInRun();
      return workerMain(task);
    });
  // What the updating binary asks the staged one before replacing itself.
  jsonOption(
    internal.command('migration-plan').description('The migration steps this binary would apply, as JSON'),
  ).action(() => {
    notInRun('board internal is not available inside a board run');
    const plan = currentPlan(realMigrationDeps(shared));
    writeJson({
      from: plan.from,
      to: plan.to,
      steps: plan.steps.map(({ id, since, title, kind }) => ({ id, since, title, kind })),
    });
  });
  // The hook of a run must never fail its tool call, so nothing it is given is a usage error.
  internal
    .command('hook')
    .description('The PreToolUse hook of a run')
    .argument('[args...]')
    .allowUnknownOption()
    .passThroughOptions()
    .action((args: string[]) => {
      // `Bash(board *)` reaches this: a run may only touch its own task's files.
      const run = env['AGENT_BOARD_TASK'];
      if (run && (args[1] !== run || args[0] !== runDir(env))) return;
      return runHook(args);
    });
}
