import { isSafeTaskId } from './contract.mts';
import { isRecord } from './guards.mts';

export const FEED_OUTCOMES = ['created', 'requeued', 'rescheduled', 'closed'] as const;
export type FeedOutcome = (typeof FEED_OUTCOMES)[number];

export interface FeedTaskOutcome {
  id: string;
  outcome: FeedOutcome;
}

export interface FeedRun {
  startedAt: string;
  at: string;
  ok: boolean;
  invalid?: true;
  error?: string;
  listed: number;
  created: number;
  requeued: number;
  rescheduled: number;
  closed: number;
  failed: number;
}

export interface FeedLastRun extends FeedRun {
  tasks: FeedTaskOutcome[];
}

export interface MachineFeed {
  id: string;
  name: string;
  integration?: string;
  action?: string;
  everyMs: number;
  paused: boolean;
  runAsked: boolean;
  problem?: string;
  last?: FeedLastRun;
  history: FeedRun[];
}

export interface MachineFeeds {
  feeds: MachineFeed[];
}

export const FEED_ACTIONS = ['pause', 'resume', 'run'] as const;
export type FeedAction = (typeof FEED_ACTIONS)[number];

export const MARKETPLACE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const INTEGRATION_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const ACTION_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const INTEGRATION_REF = /^[a-z0-9][a-z0-9-]{0,39}:[a-z0-9][a-z0-9-]{0,39}$/;

export const MAX_MACHINE_FEEDS = 30;
export const MAX_LAST_TASKS = 20;
export const MAX_HISTORY_RUNS = 10;
export const MAX_LAST_ERROR = 300;
export const MAX_HISTORY_ERROR = 120;
export const MAX_FEED_REQUESTS = 3 * MAX_MACHINE_FEEDS;
const MAX_NAME = 40;
const MAX_PROBLEM = 300;
const MAX_TIME_CHARS = 40;

export const isFeedId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{16}$/.test(value);

const isFeedAction = (value: string): value is FeedAction => FEED_ACTIONS.some((action) => action === value);

/** `pause:<id>` and the like: what the browser asks of a machine, in the clear on the board, naming no feed. */
export const feedRequest = (action: FeedAction, id: string): string => `${action}:${id}`;

export function parseFeedRequest(value: string): { action: FeedAction; id: string } | undefined {
  const [action = '', id, ...rest] = value.split(':');
  return rest.length === 0 && isFeedAction(action) && isFeedId(id) ? { action, id } : undefined;
}

const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

const isInstant = (value: unknown): value is string =>
  isText(value, MAX_TIME_CHARS) && !Number.isNaN(Date.parse(value));

function parseTask(value: unknown): FeedTaskOutcome | undefined {
  if (!isRecord(value)) return undefined;
  const { id } = value;
  const outcome = FEED_OUTCOMES.find((name) => name === value['outcome']);
  return typeof id === 'string' && isSafeTaskId(id) && outcome !== undefined ? { id, outcome } : undefined;
}

function parseRun(value: unknown, maxError: number): FeedRun | undefined {
  if (!isRecord(value)) return undefined;
  const { startedAt, at, ok, invalid, error, listed, created, requeued, rescheduled, closed, failed } = value;
  if (!isInstant(startedAt) || !isInstant(at) || typeof ok !== 'boolean') return undefined;
  if (invalid !== undefined && invalid !== true) return undefined;
  if (error !== undefined && !isText(error, maxError)) return undefined;
  if (![listed, created, requeued, rescheduled, closed, failed].every(isCount)) return undefined;
  return {
    startedAt,
    at,
    ok,
    ...(invalid === undefined ? {} : { invalid }),
    ...(error === undefined ? {} : { error }),
    listed: listed as number,
    created: created as number,
    requeued: requeued as number,
    rescheduled: rescheduled as number,
    closed: closed as number,
    failed: failed as number,
  };
}

function parseLast(value: unknown): FeedLastRun | undefined {
  const run = parseRun(value, MAX_LAST_ERROR);
  if (run === undefined || !isRecord(value) || !Array.isArray(value['tasks'])) return undefined;
  const tasks: unknown[] = value['tasks'];
  return { ...run, tasks: tasks.flatMap((entry) => parseTask(entry) ?? []).slice(0, MAX_LAST_TASKS) };
}

function parseFeed(value: unknown): MachineFeed | undefined {
  if (!isRecord(value)) return undefined;
  const { id, name, integration, action, everyMs, paused, runAsked, problem } = value;
  if (!isFeedId(id) || !isText(name, MAX_NAME) || name === '') return undefined;
  if (integration !== undefined && !(typeof integration === 'string' && INTEGRATION_REF.test(integration)))
    return undefined;
  if (action !== undefined && !(typeof action === 'string' && ACTION_NAME.test(action))) return undefined;
  if (!isCount(everyMs) || typeof paused !== 'boolean' || typeof runAsked !== 'boolean') return undefined;
  if (problem !== undefined && !isText(problem, MAX_PROBLEM)) return undefined;
  const last = value['last'] === undefined ? undefined : parseLast(value['last']);
  const entries: unknown[] = Array.isArray(value['history']) ? value['history'] : [];
  return {
    id,
    name,
    ...(integration === undefined ? {} : { integration }),
    ...(action === undefined ? {} : { action }),
    everyMs,
    paused,
    runAsked,
    ...(problem === undefined ? {} : { problem }),
    ...(last === undefined ? {} : { last }),
    history: entries.flatMap((entry) => parseRun(entry, MAX_HISTORY_ERROR) ?? []).slice(0, MAX_HISTORY_RUNS),
  };
}

export function parseMachineFeeds(json: unknown): MachineFeeds | undefined {
  if (!isRecord(json) || !Array.isArray(json['feeds'])) return undefined;
  const entries: unknown[] = json['feeds'];
  if (entries.length > MAX_MACHINE_FEEDS) return undefined;
  return { feeds: entries.flatMap((entry) => parseFeed(entry) ?? []) };
}

const runFields = (run: FeedRun) => ({
  startedAt: run.startedAt,
  at: run.at,
  ok: run.ok,
  ...(run.invalid === undefined ? {} : { invalid: run.invalid }),
  ...(run.error === undefined ? {} : { error: run.error }),
  listed: run.listed,
  created: run.created,
  requeued: run.requeued,
  rescheduled: run.rescheduled,
  closed: run.closed,
  failed: run.failed,
});

/** The one document the feeds are sealed as, and the bytes their blind index is made of: known fields only, in a fixed order. */
export function machineFeedsJson(feeds: MachineFeeds): string {
  return JSON.stringify({
    feeds: feeds.feeds.map((feed) => ({
      id: feed.id,
      name: feed.name,
      ...(feed.integration === undefined ? {} : { integration: feed.integration }),
      ...(feed.action === undefined ? {} : { action: feed.action }),
      everyMs: feed.everyMs,
      paused: feed.paused,
      runAsked: feed.runAsked,
      ...(feed.problem === undefined ? {} : { problem: feed.problem }),
      ...(feed.last === undefined
        ? {}
        : {
            last: {
              ...runFields(feed.last),
              tasks: feed.last.tasks.map(({ id, outcome }) => ({ id, outcome })),
            },
          }),
      history: feed.history.map(runFields),
    })),
  });
}

/** What is wrong with feeds the board would not take, or undefined; the sender checks before it seals. */
export function feedsProblem(feeds: MachineFeeds): string | undefined {
  if (feeds.feeds.length > MAX_MACHINE_FEEDS) return `more than ${MAX_MACHINE_FEEDS} feeds`;
  const kept = parseMachineFeeds(JSON.parse(machineFeedsJson(feeds)));
  if (kept === undefined || machineFeedsJson(kept) !== machineFeedsJson(feeds))
    return 'an entry that is not of its shape: an id, a name, a name of an integration or action, a count, a time, a task or a text';
  return undefined;
}
