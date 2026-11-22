/**
 * One task: run `claude -p` for it, keep its log and transcript, and report failures on the task.
 * Started by the dispatcher as the transient unit agent-board-<id> (on macOS, as a detached process). The agent's prompt and what comes after it travel on
 * stdin as stream-json user messages, so the worker can talk to a running agent: it tells it that a pause was requested, and
 * hands it what the user sends from the board, checking the board's run inbox every 15 seconds and whenever the board's event
 * stream says tasks changed. While the run goes on it also checks: no tool call for inactivityMinutes, or a run longer than
 * maxRunHours, interrupts it; so does a pause request that the agent does not follow within a few minutes. It passes the
 * agent's liveness on to the board.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { BackendError, isVocabularyRefusal } from '../backend/backend.mts';
import { updateCliHint, verifyContract } from '../backend/contract-check.mts';
import { loadWebConfig } from '../backend/web-config.mts';
import type { RunScope } from '../backend/web-backend.mts';
import { watchBoardChanges } from './changes.mts';
import { buildContext, print, UsageError } from '../cli.mts';
import type { Context } from '../cli.mts';
import { contextWindowsIn, logLine, parseAutoCompactPct, StreamCondenser } from '@agent-board/shared';
import type { Backend, RunInbox, Task } from '@agent-board/shared';
import { agentFor, neverRun, ownLane, removedIntakeProblem, unreadableForRun } from '../task-rules.mts';
import {
  buildInvocation,
  decideOutcome,
  isRunOver,
  planFork,
  planRun,
  pluginPlaceholders,
  supervise,
} from './plan.mts';
import type { ForkParent } from './plan.mts';
import type { Invocation } from './plan.mts';
import { goneDirNotice, inboxMessageText, lastWakeNote, pauseMessageText } from './prompts.mts';
import { createCatalogStore } from '../catalog/cache.mts';
import { initSkillsIn, recordRunSkills } from '../catalog/catalog.mts';
import { createUsageStore, rateLimitIn, sameReading, usageFile } from '../usage/usage.mts';
import type { RateLimitReading } from '../usage/usage.mts';
import { defaultLane, getPaths } from '../config/config.mts';
import { checkoutAbove, isAllowedDir, isDirectory, tryRealpath } from '../config/dirs.mts';
import { selfCommand } from '../self/self.mts';
import { autoCompactSetting, pickEnv, readMcpServers, readSettingsEnv } from './settings-env.mts';
import { contextWindowsFile, createContextWindowStore } from './context-windows.mts';
import type { ContextWindowStore } from './context-windows.mts';
import { createRunFiles } from './runtime.mts';
import type { RunFiles } from './runtime.mts';
import { createSessionStore } from './sessions.mts';
import type { SessionStore } from './sessions.mts';
import { createWorktreeLocks } from './worktree-lock.mts';
import type { WorktreeLocks } from './worktree-lock.mts';
import { appendLog, logPath, readLogTail, resetLog } from './logs.mts';
import { resolvePluginPath } from './plugins.mts';
import { plainLine } from '../output/terminal.mts';
import { requireTaskId } from '../task-id.mts';
import { errorText, fence, shellQuote } from '../output/text.mts';
import { createTranscriptUploader } from './transcript-upload.mts';
import { keepAwake } from './awake.mts';
import { runProcess } from './process.mts';
import type { RunChannel, RunResult, Watch } from './process.mts';
import { clockTime, eventsMessage } from '../watch/fence.mts';
import { publishWatches } from '../watch/publish.mts';
import { createWatchStore } from '../watch/store.mts';
import type { StoredEvent, WatchDef, WatchStore } from '../watch/store.mts';

// How long a run may take to end its turn by itself after a pause was asked for.
const PAUSE_GRACE_MINUTES = 2;
// The board's liveness is updated at most this often.
const HEARTBEAT_EVERY_MS = 15_000;
// The earliest a park wakes the task: the board refuses a time that is not in the future.
const MIN_PARK_MS = 60_000;
// How often the spool is looked at for events to hand a running agent.
const SPOOL_EVERY_MS = 2_000;
// A watch tick that finds this much more time gone than its 15 s interval ran while the machine slept (or the clock was set).
const CLOCK_JUMP_MS = 60_000;

export interface WorkerDeps extends Context {
  // `env` is added to the process's environment: the secrets of the invocation's masked variables.
  // `onLine` gets each line the process prints and returns what goes into the log for it (nothing when undefined).
  run: (
    invocation: Invocation,
    taskId: string,
    env: Record<string, string>,
    watch: Watch,
    onLine: (line: string) => string | undefined,
  ) => Promise<RunResult>;
  logTail: (taskId: string) => string;
  resetLog: (taskId: string) => void;
  appendLog: (taskId: string, text: string) => void;
  // Root of a plugin, named "pr-review" or "pr-review@ccc"; throws with the reason when it cannot be resolved.
  pluginPath: (key: string) => string;
  dirExists: (path: string) => boolean;
  // Whether anything is at the path, a file included: a linked worktree's `.git` is a file.
  pathExists: (path: string) => boolean;
  // The real path of an existing path; undefined when it is not there. Decides whether a directory is in the dirs list.
  realpath: (path: string) => string | undefined;
  // The `env` blocks of a checkout's .claude/settings*.json.
  settingsEnv: (dir: string) => Record<string, string>;
  // The named servers of a checkout's .mcp.json.
  mcpServers: (dir: string, names: string[]) => { config: { mcpServers: Record<string, unknown> }; missing: string[] };
  home: string;
  newSessionId: () => string;
  // The sessions this machine started, per task: only those are ever resumed.
  sessions: SessionStore;
  // The locks that keep a cleanup from deleting the linked worktree a task works in.
  worktreeLocks: WorktreeLocks;
  files: RunFiles;
  // The hook command line for a task, given the run directory.
  hookCommand: (runDir: string, taskId: string) => string;
  now: () => Date;
  // Calls `onChange` whenever the board says tasks changed; returns the function that stops listening. Without it only the
  // watch's own tick looks at the run inbox.
  watchChanges?: (onChange: () => void) => () => void;
  // The transcript backlog's byte budget; `createTranscriptUploader` has the default.
  maxPendingBytes?: number;
  watchEveryMs: number;
  // The watches of this machine: the worker marks its task live, hands the agent the events in the spool and parks on open watches.
  watches: WatchStore;
  // Default: 2 seconds.
  spoolEveryMs?: number;
  // Keeps the machine awake while the run goes (macOS); returns the function that ends it. Best effort.
  keepAwake?: () => () => void;
  // The run reported the skills it has in its start event: remembers them for the directory that covers `cwd`. Best effort,
  // and what it throws goes in the log.
  recordSkills?: (cwd: string, skills: unknown[]) => void;
  // The run reported the subscription's usage in a rate limit event: remembers it for the dispatcher. Called only when the
  // numbers differ from the last call of this run. Best effort, and what it throws goes in the log.
  recordUsage?: (reading: RateLimitReading) => void;
  contextWindows?: ContextWindowStore;
  // Makes the backend's calls for the task name this run, so the board refuses them once a later run holds the task.
  bindRun?: (scope: RunScope) => void;
}

export async function runWorker(deps: WorkerDeps, taskId: string): Promise<void> {
  const workerStartedAt = deps.now();
  deps.watches.markLive(taskId, process.pid);
  try {
    await runTask(deps, taskId, workerStartedAt);
  } finally {
    deps.watches.clearLive(taskId);
  }
}

// The task a fork was made from; undefined when the board has no such task. Any other failure is the run's.
async function forkParentOf(backend: Backend, id: string): Promise<ForkParent | undefined> {
  try {
    return await backend.getTask(id);
  } catch (error) {
    if (error instanceof BackendError && error.fromApi && error.status === 404) return undefined;
    throw error;
  }
}

async function runTask(deps: WorkerDeps, taskId: string, workerStartedAt: Date): Promise<void> {
  const { backend, config, watches } = deps;
  deps.resetLog(taskId);
  const task = await backend.getTask(taskId);
  if (task.run !== undefined) deps.bindRun?.({ task: task.id, run: task.run });

  const report = async (text: string): Promise<void> => {
    await backend.fail(task.id, text);
  };

  // A failure before the process starts leaves the log empty, so it goes in the log too.
  // It also ends the run, so the dispatcher's run files go.
  const fail = async (reason: string): Promise<void> => {
    deps.appendLog(taskId, reason);
    deps.files.clear(taskId);
    await report(reason);
  };

  // Never run what could not be opened: an empty prompt or a missing directory would run something else.
  const unreadable = unreadableForRun(task);
  if (unreadable.length > 0)
    return fail(
      `The task's ${unreadable.join(' and ')} could not be decrypted with this machine's data key, so it was not run. Check AGENT_BOARD_DATA_KEY against the board's Settings page.`,
    );

  const refused = neverRun(task);
  if (refused !== undefined) return fail(refused);

  const removedIntake = removedIntakeProblem(task);
  if (removedIntake !== undefined) return fail(removedIntake);

  // A task that names an agent runs as it or not at all, however it is started: a resume included.
  const agent = agentFor(task, config);
  if (agent.kind === 'missing')
    return fail(`The task runs as an agent that is not defined on this machine: ${agent.reason}, so it was not run.`);
  const restricted = agent.kind === 'found' ? agent.agent : undefined;
  // What a new directory is sealed against: the task's own creator and schedule, as the board has them.
  const sealing = {
    createdBy: task.createdBy,
    scheduleId: task.scheduleId,
    agent: task.agent ?? null,
    forkOf: task.forkOf ?? null,
  };
  const pluginRoots: Record<string, string> = {};
  for (const name of restricted === undefined
    ? []
    : pluginPlaceholders([...restricted.allowedTools, ...restricted.disallowedTools])) {
    try {
      pluginRoots[name] = deps.pluginPath(name);
    } catch (error) {
      return fail(`Cannot resolve the ${name} plugin: ${errorText(error)}`);
    }
  }
  const notes = await backend.readNotes(task.id);
  const spooled = watches.events(task.id);
  const planned = planRun(task, notes, {
    newSessionId: deps.newSessionId,
    isOwnSession: deps.sessions.has,
    watches: { events: spooled.map(({ event }) => event), open: watches.list(task.id).defs, now: deps.now() },
  });
  // A fork that starts over continues a copy of its parent's session, so the parent is looked up first.
  const run =
    planned.kind === 'fresh' && task.forkOf !== undefined
      ? planFork(planned, task, await forkParentOf(backend, task.forkOf), { isOwnSession: deps.sessions.has })
      : planned;
  if (run.kind === 'blocked') return fail(run.reason);
  // Publishing is best effort and does not hold the run.
  const publishWatchState = (): void => {
    void publishWatches(
      { store: watches, backend, now: deps.now, log: (line) => deps.appendLog(taskId, line) },
      task.id,
    );
  };
  // A run that starts over has no use for what the old one waited for; the drop takes the live marker with it.
  if (run.kind !== 'resume') {
    const hadWatches = watches.list(task.id).defs.length > 0;
    watches.dropTask(task.id);
    watches.markLive(task.id, process.pid);
    if (hadWatches) publishWatchState();
  }
  // What the prompt carries: deleted once the agent has output, which shows that it took the prompt in.
  const inPrompt: StoredEvent[] = run.kind === 'resume' ? spooled : [];
  const oldestEvent = inPrompt[0]?.event.at;
  deps.appendLog(
    taskId,
    run.kind === 'resume'
      ? `resuming session ${run.sessionId}`
      : run.kind === 'fork'
        ? `new session ${run.sessionId}, forked from session ${run.fromSessionId} of task ${run.parent.id}`
        : `new session ${run.sessionId}`,
  );
  const logTiming = (line: string): void => {
    deps.appendLog(taskId, line);
    deps.print(`${taskId} ${line}`);
  };
  if (oldestEvent !== undefined) {
    const wake = lastWakeNote(notes)?.createdAt;
    logTiming(
      `resume with watch events: oldest event ${oldestEvent}${wake === undefined ? '' : `, wake ${wake.toISOString()}`}, worker start ${workerStartedAt.toISOString()}`,
    );
  }
  // The resume is used up whether or not the run gets going. This is also the update that clears the task's `paused`.
  await backend.updateTask(task.id, { next: 'fresh' });
  const plan = buildInvocation({
    run,
    hookCommand: deps.hookCommand(deps.files.dir, taskId),
    task,
    repos: config.repos,
    defaultCwd: config.defaultCwd,
    agents: config.agents,
    agentErrors: config.agentErrors,
    agentsPath: deps.files.agentsPath(taskId),
    laneCwd: config.lanes.find((lane) => lane.name === ownLane(task, config.lanes).name)?.cwd,
    home: deps.home,
    pluginRoots,
  });
  if (!plan.ok) return fail(plan.reason);
  if (!deps.dirExists(plan.invocation.cwd)) {
    const gone = plan.invocation.cwd;
    if (task.workdir !== gone) return fail(`The working directory does not exist: ${gone}`);
    const fresh =
      'use Re-run fresh to start over in the directory it was created with, or the default one when it had none';
    // A resume keeps its session in another checkout; a fresh run has nothing worth saving.
    if (run.kind !== 'resume')
      return fail(`This task's directory is gone: ${gone}. Recreate it to run there, or ${fresh}.`);
    const fallback = checkoutAbove(gone, deps.pathExists);
    if (fallback === undefined || !deps.dirExists(fallback))
      return fail(
        `This task's directory is gone: ${plainLine(gone)}, and no git checkout above it exists on this machine to continue the session in. Recreate the directory to resume there, or ${fresh}.`,
      );
    if (!isAllowedDir(config.dirs, fallback, deps.realpath))
      return fail(
        `This task's directory is gone: ${plainLine(gone)}, and ${plainLine(fallback)}, the checkout that held it, is not a listed directory on ${config.machine}. Run "board dirs add" in it on ${config.machine} to continue the session there, recreate the directory to resume there, or ${fresh}.`,
      );
    const [oldDir, newDir] = [plainLine(gone), plainLine(fallback)];
    plan.invocation.cwd = fallback;
    plan.invocation.prompt = `${goneDirNotice(oldDir, newDir)}\n\n${plan.invocation.prompt}`;
    deps.appendLog(taskId, `directory ${oldDir} is gone; continuing the session in ${newDir}`);
    await backend
      .addNote(
        task.id,
        `This task's directory is gone: ${oldDir}. Its session continues in ${newDir}, the git checkout that held it; the agent was told to recreate its worktree there. Changes in ${oldDir} that were not committed and pushed are lost.`,
        { author: 'system' },
      )
      .catch((error: unknown) => {
        deps.appendLog(taskId, `could not add the note: ${errorText(error)}`);
      });
  }
  if (!isAllowedDir(config.dirs, plan.invocation.cwd, deps.realpath))
    return fail(
      `${plainLine(plan.invocation.cwd)} is not a listed directory on ${config.machine}: workers here run only in listed directories. Run "board dirs add" in it on ${config.machine}, then use Re-run fresh or Send & continue.`,
    );
  deps.appendLog(taskId, `working directory ${plan.invocation.cwd}`);
  // A restricted run's MCP servers come from the working directory's .mcp.json: it does not load the settings that switch them on.
  // Read only now, once the directory is known to be a listed one.
  if (restricted !== undefined && restricted.mcpServers.length > 0) {
    const servers = deps.mcpServers(plan.invocation.cwd, restricted.mcpServers);
    if (servers.missing.length > 0)
      deps.appendLog(taskId, `not in the checkout's .mcp.json: ${servers.missing.join(', ')}`);
    if (Object.keys(servers.config.mcpServers).length > 0)
      plan.invocation.args.push('--mcp-config', JSON.stringify(servers.config));
  }
  // Bound to the task from now on: it runs here unless the agent moves on (into a worktree, say).
  if (task.workdir !== plan.invocation.cwd)
    await backend.updateTask(task.id, { workdir: plan.invocation.cwd, seal: sealing });
  // A linked worktree the task is bound to is locked for it; the ones it held before (Re-run fresh, a gone directory) are not.
  const holdWorkdir = (dir: string): void => {
    const line = deps.worktreeLocks.hold(taskId, dir);
    if (line !== undefined) deps.appendLog(taskId, line);
    for (const released of deps.worktreeLocks.release(taskId, dir)) deps.appendLog(taskId, released);
  };
  holdWorkdir(plan.invocation.cwd);

  // A restricted run loads only the user's settings; the tokens and endpoints it is allowed come from the working directory's.
  // Print mode kills background work 10 minutes after the last turn; 0 waits for it, and the heartbeat and stop handling still bound the run.
  // AGENT_BOARD_START_DIR: whose settings the run loaded; a check of `board wait` gets their `env` too.
  // AGENT_BOARD_RESTRICTED: set by this machine for an agent's run, so that `board wait --check` refuses in it.
  // AGENT_BOARD_RUN: the board's id of this run; the agent's `board` sends it with its calls for the task.
  const fixedEnv = {
    AGENT_BOARD_TASK: taskId,
    ...(task.run === undefined ? {} : { AGENT_BOARD_RUN: task.run }),
    ...(agent.kind === 'found' ? { AGENT_BOARD_RESTRICTED: '1' } : {}),
    AGENT_BOARD_START_DIR: plan.invocation.cwd,
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0',
  };
  let env: Record<string, string> = fixedEnv;
  if (restricted !== undefined && restricted.env.length > 0) {
    const picked = pickEnv(deps.settingsEnv(plan.invocation.cwd), restricted.env);
    env = { ...picked.env, ...fixedEnv };
    if (picked.missing.length > 0)
      deps.appendLog(taskId, `not in the checkout's settings: ${picked.missing.join(', ')}`);
  }

  const files = deps.files;
  // The dispatcher wrote the lane before it started this worker; a run started without one counts as the default lane's own.
  const record = files.readRun(taskId) ?? {
    lane: defaultLane(config.lanes).name,
    borrowed: false,
    startedAt: deps.now(),
  };
  const startedAt = deps.now();
  let lastBeat = 0;
  let lastSeen: number | undefined;
  const beat = async (): Promise<void> => {
    const seen = files.lastActive(taskId)?.getTime();
    const due = deps.now().getTime() - lastBeat >= HEARTBEAT_EVERY_MS;
    if (lastBeat !== 0 && (!due || seen === undefined || seen === lastSeen)) return;
    lastBeat = deps.now().getTime();
    lastSeen = seen;
    await backend.heartbeat(task.id, { lane: record.lane, borrowed: record.borrowed }).catch((error: unknown) => {
      deps.appendLog(taskId, `heartbeat failed: ${errorText(error)}`);
    });
  };
  // The transcript: condensed stream-json events, sent in batches with each check and once more at the end.
  let knownWindows: Record<string, number> = {};
  try {
    knownWindows = deps.contextWindows?.read() ?? {};
  } catch (error) {
    deps.appendLog(taskId, `the machine's context windows were not read: ${errorText(error)}`);
  }
  const autoCompactPct = parseAutoCompactPct(
    autoCompactSetting([
      process.env,
      env,
      deps.settingsEnv(deps.home),
      ...(restricted === undefined ? [deps.settingsEnv(plan.invocation.cwd)] : []),
    ]),
  );
  const condenser = new StreamCondenser(deps.now, {
    knownWindow: (model) => knownWindows[model] ?? null,
    autoCompactPct,
  });
  const runId = deps.newSessionId();
  const transcript = createTranscriptUploader({
    post: (events) =>
      backend.transcript(task.id, {
        runId,
        startedAt: startedAt.toISOString(),
        sessionId: run.sessionId,
        resumed: run.kind === 'resume',
        events,
      }),
    now: deps.now,
    log: (text) => deps.appendLog(taskId, text),
    note: (text) => condenser.note(text),
    maxBytes: deps.maxPendingBytes,
  });
  let beating: Promise<void> | undefined;
  const startBeat = (): Promise<void> => {
    beating ??= beat().finally(() => {
      beating = undefined;
    });
    return beating;
  };
  let firstOutput = oldestEvent === undefined;
  // An agent's run lists the skills of the user's settings only (`--setting-sources user`), which the directory's catalogue is not.
  let skillsReported = restricted !== undefined;
  let lastUsage: RateLimitReading | undefined;
  const onLine = (line: string): string | undefined => {
    const skills = skillsReported || deps.recordSkills === undefined ? undefined : initSkillsIn(line);
    if (skills !== undefined) {
      skillsReported = true;
      try {
        deps.recordSkills?.(plan.invocation.cwd, skills);
      } catch (error) {
        deps.appendLog(taskId, `the run's skills were not recorded: ${errorText(error)}`);
      }
    }
    const usage = deps.recordUsage === undefined ? undefined : rateLimitIn(line);
    if (usage !== undefined && (lastUsage === undefined || !sameReading(usage, lastUsage))) {
      lastUsage = usage;
      try {
        deps.recordUsage?.(usage);
      } catch (error) {
        deps.appendLog(taskId, `the run's usage was not recorded: ${errorText(error)}`);
      }
    }
    const windows = deps.contextWindows === undefined ? undefined : contextWindowsIn(line);
    if (windows !== undefined) {
      try {
        deps.contextWindows?.record(windows);
      } catch (error) {
        deps.appendLog(taskId, `the run's context windows were not recorded: ${errorText(error)}`);
      }
    }
    if (!firstOutput && oldestEvent !== undefined) {
      firstOutput = true;
      const at = deps.now().getTime();
      watches.deleteEvents(
        task.id,
        inPrompt.map(({ file }) => file),
      );
      publishWatchState();
      logTiming(
        `first agent output after ${at - workerStartedAt.getTime()} ms from worker start, ${at - Date.parse(oldestEvent)} ms from the oldest event`,
      );
    }
    const events = condenser.line(line);
    transcript.add(events);
    const text = events.map(logLine).filter((part) => part !== undefined);
    return text.length > 0 ? text.join('\n') : undefined;
  };
  // What the user sent the running agent: messages are handed over, a stop request interrupts it. One look at a time; a change
  // that comes in meanwhile makes one more.
  let channel: RunChannel | undefined;
  let inboxOff = false;
  // The board answered the run inbox with 409: the task is no longer Running (board ask, board wait).
  let leftRunning = false;
  let looking: Promise<void> | undefined;
  let lookAgain = false;
  // The messages the agent has been handed, so that a lost acknowledgement does not hand one over twice.
  const handedOver = new Set<string>();
  // An interrupt for a stop request is out and not acknowledged yet: the request is not acted on again.
  let interrupted = false;
  // The run was ended because the user asked for a stop, with nothing to carry on with.
  let endedByStop = false;
  let pauseTold = false;
  const logFailure = (what: string, error: unknown): void => {
    deps.appendLog(taskId, `${what}: ${errorText(error)}`);
  };
  const handOver = async (live: RunChannel, inbox: RunInbox): Promise<string[]> => {
    const acknowledged: string[] = [];
    for (const message of inbox.messages) {
      // Only the user's own comments are the agent's to read: the board's answer is not trusted to hold anything else.
      if (message.author !== 'user' || message.kind !== 'comment') {
        deps.appendLog(
          taskId,
          `a note in the run inbox is not a comment of the user's, so it was not handed to the agent; it is acknowledged so that it does not come back (${message.id})`,
        );
      } else if (message.unreadable) {
        deps.appendLog(
          taskId,
          `a message of the user's could not be decrypted with this machine's data key, so it was not handed to the agent; it is acknowledged so that it does not come back (${message.id})`,
        );
      } else if (!handedOver.has(message.id)) {
        if (!live.send(inboxMessageText(task.id, message, inbox.stop))) break;
        handedOver.add(message.id);
        deps.appendLog(taskId, `handed the agent a message of the user's (${message.id})`);
      }
      acknowledged.push(message.id);
    }
    return acknowledged;
  };
  const lookAtInbox = async (): Promise<void> => {
    const live = channel;
    if (inboxOff || live === undefined || !live.open) return;
    let inbox: RunInbox;
    try {
      inbox = await backend.runInbox(task.id);
    } catch (error) {
      if (error instanceof BackendError && error.missingFeature !== undefined) {
        inboxOff = true;
        deps.appendLog(taskId, 'the board has no run inbox: messages and stop requests are not delivered');
      } else if (error instanceof BackendError && error.status === 409) leftRunning = true;
      else logFailure('run inbox failed', error);
      return;
    }
    // The run ended while the board answered.
    if (!live.open) return;
    const act = inbox.stop && !interrupted;
    // A plain stop hands nothing over: what is pending stays pending. Stop & send hands over all of it, the stop's own message last.
    const plainStop = inbox.stop && inbox.stopMessage === undefined;
    if (act) {
      if (!plainStop) live.interrupt();
      interrupted = true;
      deps.appendLog(taskId, 'the user asked to stop: interrupted the agent');
    }
    const ids = plainStop ? [] : await handOver(live, inbox);
    // A message after the interruption carries the run on; without one the run ends.
    if (inbox.stop && (plainStop || !inbox.messages.some((message) => handedOver.has(message.id)))) {
      live.stop();
      endedByStop = true;
    }
    if (ids.length === 0 && !inbox.stop) return;
    try {
      await backend.ackMessages(task.id, { ids, stop: inbox.stop });
      if (inbox.stop) interrupted = false;
    } catch (error) {
      logFailure('acknowledging the run inbox failed', error);
    }
  };
  const startLooking = (): Promise<void> => {
    if (looking !== undefined) {
      lookAgain = true;
      return looking;
    }
    looking = lookAtInbox()
      .catch((error: unknown) => logFailure('run inbox failed', error))
      .finally(() => {
        looking = undefined;
        if (lookAgain) {
          lookAgain = false;
          void startLooking();
        }
      });
    return looking;
  };
  // Events that came while the run went on reach the agent in a message; the file of an event goes once it is written to it.
  // A turn end holds the spool from its read until its message is out, so that the two do not hand over the same events.
  let turnHoldsSpool = false;
  let turnFiles: string[] = [];
  const handedWatchEvents = (stored: StoredEvent[]): void => {
    watches.deleteEvents(
      task.id,
      stored.map(({ file }) => file),
    );
    publishWatchState();
    const names = [...new Set(stored.map(({ event }) => event.name))].join(', ');
    deps.appendLog(taskId, `handed the agent ${stored.length} watch event(s) (${names})`);
  };
  const unprompted = (): StoredEvent[] => {
    const prompted = new Set(inPrompt.map(({ file }) => file));
    return watches.events(task.id).filter(({ file }) => !prompted.has(file));
  };
  const eventsText = (stored: StoredEvent[]): string =>
    eventsMessage(
      task.id,
      stored.map(({ event }) => event),
      watches.list(task.id).defs,
      deps.now(),
    );
  // Once the task left Running or a pause was asked for, the events wait for the resume.
  const holdsEvents = (): boolean => leftRunning || files.pauseRequestedAt(taskId) !== undefined;
  const handOverSpool = (): void => {
    const live = channel;
    if (turnHoldsSpool || live === undefined || !live.open || holdsEvents()) return;
    try {
      const stored = unprompted();
      if (stored.length > 0 && live.send(eventsText(stored))) handedWatchEvents(stored);
    } catch (error) {
      logFailure('handing over watch events failed', error);
    }
  };
  // At the end of a turn: events the run has not seen go on as its next turn, but only while the task is still this run's to
  // continue. After `board ask`, a wait or a move the events stay for the next resume, and never pull a task out of Needs me.
  const handOverAtTurnEnd = async (): Promise<string | undefined> => {
    if (unprompted().length === 0 || holdsEvents()) return undefined;
    turnHoldsSpool = true;
    try {
      const current = await backend.getTask(task.id);
      if (current.status !== 'running' || isRunOver(task, current) || holdsEvents()) return undefined;
      const stored = unprompted();
      if (stored.length === 0) return undefined;
      turnFiles = stored.map(({ file }) => file);
      return eventsText(stored);
    } catch (error) {
      logFailure('could not hand the agent the watch events at the end of its turn', error);
      return undefined;
    } finally {
      if (turnFiles.length === 0) turnHoldsSpool = false;
    }
  };
  const turnMessageSent = (): void => {
    const files = turnFiles;
    turnFiles = [];
    turnHoldsSpool = false;
    handedWatchEvents(watches.events(task.id).filter(({ file }) => files.includes(file)));
  };
  let spoolTimer: NodeJS.Timeout | undefined;
  let lastTickAt = deps.now().getTime();
  const watch: Watch = {
    everyMs: deps.watchEveryMs,
    spawned: (pgid) => files.writeProcessGroup(taskId, pgid),
    start: (live) => {
      channel = live;
      spoolTimer = setInterval(handOverSpool, deps.spoolEveryMs ?? SPOOL_EVERY_MS);
      // The board marks the run as one that reads its inbox, which is what keeps a late message from being lost.
      void startLooking();
    },
    onTurnEnd: handOverAtTurnEnd,
    turnMessageSent,
    tick: async () => {
      // A sleep is not inactivity: after a jump the agent's last sign of life moves up to now, here and for the
      // dispatcher's sweep, which reads the same file.
      const tickAt = deps.now().getTime();
      if (tickAt - lastTickAt > CLOCK_JUMP_MS) {
        files.touchAlive(taskId, deps.now());
        deps.appendLog(
          taskId,
          `the clock jumped ${Math.round((tickAt - lastTickAt) / 1000)} s (the machine slept?): the idle time starts over`,
        );
      }
      lastTickAt = tickAt;
      void startBeat();
      void transcript.start();
      void startLooking();
      if (!pauseTold && channel?.open && files.pauseRequestedAt(taskId) !== undefined) {
        pauseTold = channel.send(pauseMessageText(task.id));
        if (pauseTold)
          deps.appendLog(taskId, 'the lane needs the slot: asked the agent to post a status and end its turn');
      }
      return supervise({
        now: deps.now(),
        startedAt,
        lastActive: files.lastActive(taskId),
        pauseRequestedAt: files.pauseRequestedAt(taskId),
        limits: config,
        pauseGraceMinutes: PAUSE_GRACE_MINUTES,
      });
    },
  };

  // Stored only now that the run is about to start: a reply to a run that never began must not resume its session.
  if (run.kind !== 'resume') {
    deps.sessions.record(task.id, run.sessionId);
    await backend.updateTask(task.id, { sessionId: run.sessionId });
  }
  let result: RunResult;
  const stopListening = deps.watchChanges?.(() => void startLooking());
  const stopAwake = deps.keepAwake?.();
  try {
    if (plan.agents !== undefined) deps.files.writeAgents(taskId, plan.agents.content);
    void startBeat();
    result = await deps.run(plan.invocation, taskId, env, watch, onLine);
  } catch (error) {
    stopAwake?.();
    stopListening?.();
    clearInterval(spoolTimer);
    files.clear(taskId);
    if (run.kind !== 'resume') await backend.updateTask(task.id, { sessionId: null });
    return fail(errorText(error));
  }
  stopAwake?.();
  stopListening?.();
  clearInterval(spoolTimer);
  await transcript.flush();
  if (result.stopped) deps.appendLog(taskId, result.stopped.message);
  const pauseRequested = files.pauseRequestedAt(taskId) !== undefined;
  const endedIn = files.lastCwd(taskId);
  let after: Task;
  try {
    after = await backend.getTask(task.id);
  } catch (error) {
    if (!isVocabularyRefusal(error)) {
      files.clear(taskId);
      throw error;
    }
    // The run's files stay: once the CLI is updated, the sweep finds this task running without a unit and deals with it.
    deps.appendLog(
      taskId,
      `the board shows this task with a value this CLI does not know, so its end is not reported; ${updateCliHint()}`,
    );
    return;
  }
  files.clear(taskId);
  // The agent ended its turn with watches open: the task waits for them, without the agent having to say so.
  const parkOnWatches = async (open: WatchDef[]): Promise<void> => {
    const now = deps.now();
    // The board wants a time in the future; a deadline that has passed is for the tick or the unit to act on soon.
    const earliest = Math.max(
      now.getTime() + MIN_PARK_MS,
      open.length === 0 ? 0 : Math.min(...open.map(({ deadline }) => Date.parse(deadline))),
    );
    const list =
      open.length === 0
        ? 'a watch event'
        : open.map(({ name, deadline }) => `"${name}" (until ${clockTime(new Date(deadline), now)})`).join(', ');
    try {
      await backend.wait(task.id, {
        text: `Waiting for watches: ${list}.`,
        wakeAt: new Date(earliest),
        check: open.some(({ source }) => source.kind !== 'timer'),
      });
      deps.appendLog(taskId, `the task waits for its watches: ${list}`);
    } catch (error) {
      if (!(error instanceof BackendError && (error.status === 409 || error.status === 400))) throw error;
      deps.appendLog(taskId, `the board did not park the task on its watches: ${errorText(error)}`);
    }
  };
  try {
    // The core never writes to a task that left the workflow or runs again elsewhere, whatever this run's outcome.
    if (isRunOver(task, after)) return;
    // The session's directory as it stopped: a later resume must start in the same place, worktree included.
    let workdir = plan.invocation.cwd;
    if (endedIn !== undefined && endedIn !== plan.invocation.cwd) {
      if (isAllowedDir(config.dirs, endedIn, deps.realpath)) {
        await backend.updateTask(task.id, { workdir: endedIn, seal: sealing });
        workdir = endedIn;
        deps.appendLog(taskId, `the session ended in ${endedIn}`);
      } else {
        // Stored, it would strand the task: the next start would refuse its own directory.
        const shown = plainLine(endedIn);
        deps.appendLog(taskId, `the session ended in ${shown}, not a listed directory; the workdir stays`);
        await backend
          .addNote(
            task.id,
            `The agent ended in ${shown}, which is not a listed directory on ${config.machine}. The next resume starts in ${plainLine(plan.invocation.cwd)}.`,
            { author: 'system' },
          )
          .catch((error: unknown) => {
            deps.appendLog(taskId, `could not add the note: ${error instanceof Error ? error.message : String(error)}`);
          });
      }
    }
    // The workdir keeps its lock; worktrees the agent only passed through during the run lose theirs.
    holdWorkdir(workdir);
    const openWatches = watches.list(task.id).defs;
    const outcome = decideOutcome({
      exitCode: result.exitCode,
      signal: result.signal,
      stopped: result.stopped,
      pauseRequested,
      stopRequested: endedByStop,
      reported: after.status !== 'running',
      watching: openWatches.length > 0 || unprompted().length > 0,
    });
    if (outcome.kind === 'ok') return;
    if (outcome.kind === 'parked') {
      await parkOnWatches(openWatches);
      return;
    }
    if (outcome.kind === 'stopped') {
      if (after.status === 'running') await backend.stopped(task.id, 'Stopped by you.');
      return;
    }
    if (outcome.kind === 'paused') {
      if (after.status === 'running')
        await backend.pause(
          task.id,
          `Paused on ${config.machine}: its ${record.lane} lane needed the slot for its own work. Resumes next, on ${config.machine}.`,
        );
      return;
    }
    const why = outcome.kind === 'failed' ? outcome.reason : 'The worker finished without reporting on the task.';
    await report(`${why}\n\nEnd of the log:\n${fence(deps.logTail(taskId) || '(empty)')}`);
  } catch (error) {
    if (!isVocabularyRefusal(error)) throw error;
    deps.appendLog(
      taskId,
      `the board refused to show this task to this CLI, so the end of the run is not reported; ${updateCliHint()}`,
    );
  }
}

// Hook commands run through a shell.
export function hookCommand(runDir: string, id: string): string {
  return `${selfCommand('internal', 'hook').map(shellQuote).join(' ')} ${shellQuote(runDir)} ${shellQuote(id)}`;
}

export async function workerMain(taskId: string): Promise<void> {
  requireTaskId(taskId, UsageError);
  let run: RunScope | undefined;
  const context = buildContext(false, { run: () => run });
  print(`worker ${taskId} log=${logPath(taskId)}`);
  const deps: WorkerDeps = {
    ...context,
    run: runProcess,
    logTail: readLogTail,
    resetLog,
    appendLog,
    pluginPath: resolvePluginPath,
    dirExists: isDirectory,
    pathExists: existsSync,
    realpath: tryRealpath,
    settingsEnv: readSettingsEnv,
    mcpServers: readMcpServers,
    home: homedir(),
    newSessionId: randomUUID,
    sessions: createSessionStore(),
    worktreeLocks: createWorktreeLocks(),
    files: createRunFiles(),
    watches: createWatchStore(),
    hookCommand,
    now: () => new Date(),
    watchChanges: (onChange) => {
      const stop = new AbortController();
      void (async () => {
        try {
          const config = loadWebConfig(getPaths().configDir);
          // A board without the stream is only checked on the timer.
          if (!(await verifyContract(config)).features.has('events')) return;
          await watchBoardChanges(
            {
              config,
              fetch: (url, init) => fetch(url, init),
              onChange,
              log: (line) => appendLog(taskId, line),
              retryMs: 10_000,
              idleMs: 60_000,
            },
            stop.signal,
          );
        } catch (error) {
          appendLog(taskId, `no event stream for the run inbox: ${errorText(error)}`);
        }
      })();
      return () => stop.abort();
    },
    watchEveryMs: 15_000,
    ...(process.platform === 'darwin' ? { keepAwake: () => keepAwake() } : {}),
    recordSkills: (cwd, skills) =>
      recordRunSkills({ store: createCatalogStore(), config: context.config }, cwd, skills),
    recordUsage: (reading) => createUsageStore(usageFile(getPaths().stateDir)).record(reading, new Date()),
    contextWindows: createContextWindowStore(contextWindowsFile(getPaths().stateDir)),
    bindRun: (scope) => {
      run = scope;
    },
  };
  try {
    await runWorker(deps, taskId);
  } catch (error) {
    appendLog(taskId, `worker failed: ${errorText(error)}`);
    throw error;
  }
}
