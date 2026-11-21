import { isModelName, isSafeWorkdir, isSessionId, parsePrUrl, prUrlIn } from '@agent-board/shared';
import type { Note, Task } from '@agent-board/shared';
import type { AgentConfig } from '../config/config.mts';
import { agentFor, neverRun, removedIntakeProblem } from '../task-rules.mts';
import {
  boardRules,
  buildResumePrompt,
  forkPrompt,
  freshThreadBlock,
  userReply,
  writtenSincePreviousRun,
} from './prompts.mts';
import type { ResumeWatches } from './prompts.mts';

// `{<plugin>}` in an allow or deny rule stands for the root Claude Code gives the one installed `<plugin>@*`, such as
// {pr-review}; `{<plugin>@<marketplace>}` names the marketplace.
const PLUGIN_PLACEHOLDER = /\{([a-z0-9][a-z0-9-]*(?:@[A-Za-z0-9][A-Za-z0-9._-]*)?)\}/g;

export interface RunLimits {
  inactivityMinutes: number;
  maxRunHours: number;
}

export type Supervision =
  { kind: 'continue' } | { kind: 'stop'; why: 'inactive' | 'ceiling' | 'pause-forced'; message: string };

// What the worker does with a run that is still going, checked on every worker tick (15 s).
export function supervise(input: {
  now: Date;
  startedAt: Date;
  // The agent's last tool call; undefined before its first one.
  lastActive: Date | undefined;
  pauseRequestedAt: Date | undefined;
  limits: RunLimits;
  // How long a run may take to stop by itself after a pause was asked for.
  pauseGraceMinutes: number;
}): Supervision {
  const minutesSince = (date: Date) => (input.now.getTime() - date.getTime()) / 60_000;
  if (input.pauseRequestedAt !== undefined && minutesSince(input.pauseRequestedAt) > input.pauseGraceMinutes) {
    return {
      kind: 'stop',
      why: 'pause-forced',
      message: `The run did not end its turn within ${input.pauseGraceMinutes} minutes of the pause request and was interrupted.`,
    };
  }
  if (minutesSince(input.startedAt) > input.limits.maxRunHours * 60) {
    return {
      kind: 'stop',
      why: 'ceiling',
      message: `Stopped after ${input.limits.maxRunHours} hours, the longest a run may take.`,
    };
  }
  if (minutesSince(input.lastActive ?? input.startedAt) > input.limits.inactivityMinutes) {
    return {
      kind: 'stop',
      why: 'inactive',
      message: `Stopped: the agent made no tool call for ${input.limits.inactivityMinutes} minutes.`,
    };
  }
  return { kind: 'continue' };
}

// The plugins whose roots the rules name, as written between the braces: ["pr-review", "engineering@ccc"].
export function pluginPlaceholders(rules: string[]): string[] {
  return [
    ...new Set(rules.flatMap((rule) => [...rule.matchAll(PLUGIN_PLACEHOLDER)].map((match) => match[1] ?? ''))),
  ].filter(Boolean);
}

// `~/` and `{<plugin>}` are expanded inside Bash rules only: Read rules read `~/` themselves, and an absolute path
// there would mean "from the project root".
export function expandRule(rule: string, home: string, pluginRoots: Record<string, string>): string {
  if (!rule.startsWith('Bash(')) return rule;
  return rule
    .replaceAll('~/', `${home}/`)
    .replace(PLUGIN_PLACEHOLDER, (match, name: string) => pluginRoots[name] ?? match);
}

export interface FreshRun {
  kind: 'fresh';
  sessionId: string;
  thread?: string;
}

// The task a fork was made from, as the board has it.
export type ForkParent = Pick<Task, 'id' | 'title' | 'sessionId'>;

// What the worker starts: a new Claude session, a copy of another task's session (a fork), or the task's last one with the
// user's reply; or why it starts nothing. A fork's `sessionId` is the copy's own, and `fromSessionId` the parent's.
export type RunPlan =
  | FreshRun
  | {
      kind: 'fork';
      sessionId: string;
      fromSessionId: string;
      parent: Pick<ForkParent, 'id' | 'title'>;
      thread?: string;
    }
  | { kind: 'resume'; sessionId: string; prompt: string }
  | { kind: 'blocked'; reason: string };

const UNREADABLE_NOTE_REASON =
  "A comment or answer in this task's thread could not be decrypted with this machine's data key, and this run would have handed it to the agent, so it was not run. Check AGENT_BOARD_DATA_KEY, or use Re-run fresh: a fresh run starts after this attempt and is not handed the note.";

export interface RunPlanOptions {
  newSessionId: () => string;
  // Whether this machine started that Claude session for that task. The board names the session to resume in the clear, so
  // a session this machine has no record of is never resumed: the id could be another task's, or another conversation.
  isOwnSession: (taskId: string, sessionId: string) => boolean;
  // What the task's watches have to say to a resumed run: undelivered events alone make a resume prompt.
  watches?: ResumeWatches;
}

/**
 * Resume when the user asked for it, a session exists and there is a reply to give it; otherwise start over. A run is blocked
 * when it would resume a session this machine did not start for the task, or hand the agent a note of the user's that could
 * not be opened: the agent would act on less than the user wrote.
 */
export function planRun(task: Task, notes: Note[], options: RunPlanOptions): RunPlan {
  if (task.next === 'resume' && task.sessionId !== null) {
    const prompt = buildResumePrompt(task, notes, options.watches);
    if (prompt !== undefined) {
      if (!options.isOwnSession(task.id, task.sessionId))
        return {
          kind: 'blocked',
          reason: `The board asks to resume Claude session ${task.sessionId}, which this machine did not start for this task, so the run was not started. Use Re-run fresh to start over.`,
        };
      if (userReply(notes, task.runStartedAt).some((note) => note.unreadable))
        return { kind: 'blocked', reason: UNREADABLE_NOTE_REASON };
      return { kind: 'resume', sessionId: task.sessionId.toLowerCase(), prompt };
    }
  }
  if (writtenSincePreviousRun(task, notes).some((note) => note.unreadable))
    return { kind: 'blocked', reason: UNREADABLE_NOTE_REASON };
  const thread = freshThreadBlock(task, notes);
  return { kind: 'fresh', sessionId: options.newSessionId(), ...(thread === undefined ? {} : { thread }) };
}

/**
 * A start-over of a fork continues a copy of the session of the task it was forked from, and that session is the board's word
 * for it: the run is blocked unless this machine started that session for that task, like a resume. `parent` is the task the
 * board answered for the fork link; undefined when there is none.
 */
export function planFork(
  fresh: FreshRun,
  task: Pick<Task, 'forkOf'>,
  parent: ForkParent | undefined,
  options: Pick<RunPlanOptions, 'isOwnSession'>,
): RunPlan {
  const { forkOf } = task;
  if (forkOf === undefined) return fresh;
  const blocked = (why: string): RunPlan => ({
    kind: 'blocked',
    reason: `This task was forked from task ${forkOf}, ${why}, so there is no session to continue and the run was not started. Close it, or fork the task you want to continue again.`,
  });
  if (parent === undefined) return blocked('which is not on the board any more');
  // The sealed link names the parent; the board's answer for it is only believed when it is that task.
  if (parent.id !== forkOf) return blocked('but the board answered with another task');
  if (parent.sessionId === null) return blocked('which has no Claude session now (it never ran, or was re-run fresh)');
  if (!options.isOwnSession(forkOf, parent.sessionId))
    return blocked('whose session this machine did not start, and a fork runs on the machine of its parent');
  return {
    kind: 'fork',
    sessionId: fresh.sessionId,
    fromSessionId: parent.sessionId.toLowerCase(),
    parent: { id: forkOf, title: parent.title },
    ...(fresh.thread === undefined ? {} : { thread: fresh.thread }),
  };
}

/**
 * The run this worker started is no longer the task's to report on: the task was closed (archived, parked by hand: nobody
 * is waiting), or it was taken back and run again, so the `running` it shows is another run's. A task that left Running
 * is still this run's: the board drops `run` and `runStartedAt` with the move, so only a running task's run id (or, from a
 * board without `task.run`, its start) tells runs apart.
 */
export function isRunOver(
  started: Pick<Task, 'runStartedAt' | 'run'>,
  after: Pick<Task, 'closed' | 'status' | 'runStartedAt' | 'run'>,
): boolean {
  if (after.closed) return true;
  if (after.status !== 'running') return false;
  // The run id when the board has one (`task.run`); its start otherwise.
  if (started.run !== undefined) return after.run !== started.run;
  return after.runStartedAt?.getTime() !== started.runStartedAt?.getTime();
}

export type Outcome =
  | { kind: 'ok' }
  // The agent ended its turn with watches open: the task waits for them.
  | { kind: 'parked' }
  | { kind: 'failed'; reason: string }
  | { kind: 'unreported' }
  | { kind: 'paused' }
  | { kind: 'stopped' };

export function decideOutcome(input: {
  exitCode: number | null;
  signal: string | null;
  // Why the worker stopped the run itself, if it did.
  stopped: Exclude<Supervision, { kind: 'continue' }> | undefined;
  // The dispatcher asked the run to give up its slot.
  pauseRequested: boolean;
  // The worker ended the run because the user asked it to stop.
  stopRequested: boolean;
  shutdownRequested: boolean;
  // The task is no longer Running: the agent reported, the user answered, or the task was taken back.
  reported: boolean;
  // The task has open watches on this machine.
  watching: boolean;
}): Outcome {
  // A run that reported before it noticed the pause or the stop is simply done.
  if (input.reported)
    return input.exitCode === 0 || input.pauseRequested || input.stopRequested || input.shutdownRequested
      ? { kind: 'ok' }
      : failed(input);
  if (input.stopRequested) return { kind: 'stopped' };
  if (input.pauseRequested || input.shutdownRequested) return { kind: 'paused' };
  if (input.stopped) return { kind: 'failed', reason: input.stopped.message };
  if (input.exitCode !== 0) return failed(input);
  return input.watching ? { kind: 'parked' } : { kind: 'unreported' };
}

function failed(input: { exitCode: number | null; signal: string | null }): Outcome {
  const how = input.signal ? `was killed by ${input.signal}` : `exited with code ${input.exitCode}`;
  return { kind: 'failed', reason: `The worker ${how}.` };
}

export interface Invocation {
  command: string;
  // Options only, and never the prompt: `claude` would read a prompt that starts with a dash as an option, and some options
  // start things (`--mcp-config`) before any permission applies.
  args: string[];
  // The prompt, from the board (a sealed prompt, a reply). It reaches `claude` on stdin as the first user message of the
  // stream-json input, JSON-encoded, so it is only ever text.
  prompt: string;
  cwd: string;
}

// `agents`: for an agent's run, the file `--agents` names and what the worker writes into it (mode 0600) before it starts.
export type InvocationPlan =
  { ok: true; invocation: Invocation; agents?: { path: string; content: string } } | { ok: false; reason: string };

// What a restricted run's allow and deny lists become: `~/` and plugin roots expanded, or why the run must not start.
// `owner` names whose rules they are in the refusals.
function expandedRules(
  lists: { allowedTools: string[]; disallowedTools: string[] },
  owner: { rules: string; rule: string },
  input: { home: string; pluginRoots: Record<string, string> },
): { ok: true; allowed: string[]; disallowed: string[] } | { ok: false; reason: string } {
  const missing = pluginPlaceholders([...lists.allowedTools, ...lists.disallowedTools]).filter(
    (name) => !Object.hasOwn(input.pluginRoots, name),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `The path of the plugin ${missing.join(', ')} is unknown, but ${owner.rules} name {${missing[0]}}.`,
    };
  }
  const expand = (rule: string): string => expandRule(rule, input.home, input.pluginRoots);
  const allowed = lists.allowedTools.map(expand);
  const disallowed = lists.disallowedTools.map(expand);
  // The two lists take every following argument that does not start with `-`: a rule that does would read as an option.
  const optionLike = [...allowed, ...disallowed].find((rule) => rule.startsWith('-'));
  if (optionLike !== undefined)
    return {
      ok: false,
      reason: `${owner.rule} starts with "-" and would be read as an option: ${optionLike.slice(0, 40)}`,
    };
  return { ok: true, allowed, disallowed };
}

export function buildInvocation(input: {
  task: Task;
  run: RunPlan;
  repos: Record<string, string>;
  // Where a task without a directory of its own runs.
  defaultCwd: string;
  // The agents this machine defines. A task that names one runs as it, under its lists, and a task that names an agent not
  // here is refused.
  agents: Record<string, AgentConfig>;
  agentErrors: Record<string, string>;
  // Where the worker will write the agent's definition for `--agents`, in a private directory.
  agentsPath: string;
  // The directory a task without its own runs in when no PR in its prompt names a checkout (its lane's, if set).
  laneCwd?: string | undefined;
  home: string;
  // Roots of the plugins the rules name ({pr-review} and the like), by the placeholder as written.
  pluginRoots: Record<string, string>;
  // The PreToolUse hook command (heartbeat, working directory).
  hookCommand?: string;
}): InvocationPlan {
  const { task } = input;
  const agent = agentFor(task, input);
  const prompt = task.input.trim();
  const refused = neverRun(task);
  if (refused !== undefined) return { ok: false, reason: refused };
  const removedIntake = removedIntakeProblem(task);
  if (removedIntake !== undefined) return { ok: false, reason: removedIntake };
  if (agent.kind === 'missing')
    return { ok: false, reason: `The task runs as an agent that is not defined on this machine: ${agent.reason}.` };
  if (input.run.kind === 'blocked') return { ok: false, reason: input.run.reason };
  if (input.run.kind !== 'resume' && prompt === '') return { ok: false, reason: 'The task has no prompt.' };
  if (!isSessionId(input.run.sessionId) || (input.run.kind === 'fork' && !isSessionId(input.run.fromSessionId)))
    return { ok: false, reason: 'The session id is not a UUID.' };
  if (task.workdir !== null && !isSafeWorkdir(task.workdir))
    return { ok: false, reason: 'The task directory is not an absolute path.' };
  if (task.model !== null && !isModelName(task.model))
    return { ok: false, reason: 'The task model is not a model name.' };

  // Where it runs: a resume where the session stopped; a scheduled task in its own directory; a task whose prompt
  // names a PR in that repo's checkout; else its lane's directory, else the default one.
  const pr = parsePrUrl(prUrlIn(task.input) ?? '');
  const checkout = pr === undefined ? undefined : input.repos[pr.repo];
  const cwd = task.workdir ?? checkout ?? input.laneCwd ?? input.defaultCwd;

  const settings =
    input.hookCommand === undefined
      ? {}
      : { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: input.hookCommand }] }] } };
  // One argument each, so an id can never be read as a flag of its own. A fork resumes the parent's session into a copy that
  // has the new id, and leaves the parent's as it is.
  const session =
    input.run.kind === 'resume'
      ? [`--resume=${input.run.sessionId}`]
      : input.run.kind === 'fork'
        ? [`--resume=${input.run.fromSessionId}`, '--fork-session', `--session-id=${input.run.sessionId}`]
        : [`--session-id=${input.run.sessionId}`];
  const startPrompt = input.run.kind === 'fork' ? forkPrompt(task, input.run.parent, cwd, prompt) : prompt;
  const promptText =
    input.run.kind === 'resume'
      ? input.run.prompt
      : [startPrompt, input.run.thread].filter((part) => part !== undefined).join('\n\n');
  const args = [
    '-p',
    ...session,
    // One argument, like the session id.
    ...(task.model === null ? [] : [`--model=${task.model}`]),
    // Every event as a JSON line: the worker keeps a readable log and sends the transcript to the board.
    '--output-format',
    'stream-json',
    // Messages and an interrupt can follow the prompt on stdin while the run goes on.
    '--input-format',
    'stream-json',
    '--verbose',
    '--append-system-prompt',
    boardRules(task, { asAgent: agent.kind === 'found' }),
    // The heartbeat and question hook, inline.
    '--settings',
    JSON.stringify(settings),
  ];
  if (agent.kind === 'found') {
    // An agent's run is unattended and runs only what the agent's lists allow, in dontAsk mode: the agent's `tools` limit
    // the tool names only, so the command-level rules take effect only with dontAsk. Only the user's own settings load.
    const rules = expandedRules(
      agent.agent,
      { rules: `agent ${agent.name}'s rules`, rule: `A tool rule of agent ${agent.name}` },
      input,
    );
    if (!rules.ok) return rules;
    // `--tools` keeps the built-in tools out even if Claude Code cannot load the agent and runs the main thread as itself;
    // MCP tools are not built in, and the lists govern them.
    args.push(
      `--tools=${agent.agent.tools.filter((tool) => !tool.startsWith('mcp__')).join(',')}`,
      `--agents=${input.agentsPath}`,
      `--agent=${agent.name}`,
      '--permission-mode',
      'dontAsk',
      '--setting-sources',
      'user',
    );
    if (rules.allowed.length > 0) args.push('--allowedTools', ...rules.allowed);
    if (rules.disallowed.length > 0) args.push('--disallowedTools', ...rules.disallowed);
    return {
      ok: true,
      invocation: { command: 'claude', args, prompt: promptText, cwd },
      agents: { path: input.agentsPath, content: agentsFileContent(agent.name, agent.agent) },
    };
  }
  // As if the user ran it: their settings (user, project, local) and auto mode, which lets safe actions through and
  // refuses risky ones. Headless, a refusal cannot become a prompt; it shows in the log.
  args.push('--permission-mode', 'auto');
  return { ok: true, invocation: { command: 'claude', args, prompt: promptText, cwd } };
}

// The definition `claude --agents` reads: only the keys Claude Code knows. Its servers come with `--mcp-config` instead,
// and the allow and deny lists are command-line options.
function agentsFileContent(name: string, agent: AgentConfig): string {
  return JSON.stringify({
    [name]: {
      description: agent.description,
      prompt: agent.prompt ?? '',
      tools: agent.tools,
      ...(agent.model === undefined ? {} : { model: agent.model }),
    },
  });
}
