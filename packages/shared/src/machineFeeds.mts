// The feeds of a machine (`board feeds`) as the board shows them: each one's name, timer, pause and last run. Sent as one
// sealed document (`machine.feeds`, see sealing.mts); the commands stay on the machine. The browser acts on a feed only by
// its opaque id, through a request the machine applies itself, so everything here is display only and shape-checked again
// when it is opened.
import { isRecord } from './guards.mts';

export interface FeedLastRun {
  at: string;
  ok: boolean;
  error?: string;
  listed: number;
  created: number;
  requeued: number;
  closed: number;
  failed: number;
}

export interface MachineFeed {
  // Random, made by the machine the first time it sees the feed; requests name it.
  id: string;
  name: string;
  everyMs: number;
  paused: boolean;
  // A run was asked for and has not happened yet.
  runNow: boolean;
  // Why config.json's entry cannot be used; such a feed does not run.
  problem?: string;
  last?: FeedLastRun;
}

export interface MachineFeeds {
  feeds: MachineFeed[];
}

export const FEED_ACTIONS = ['pause', 'resume', 'run'] as const;
export type FeedAction = (typeof FEED_ACTIONS)[number];

export const MAX_MACHINE_FEEDS = 50;
// Pending requests of one machine: a few per feed.
export const MAX_FEED_REQUESTS = 3 * MAX_MACHINE_FEEDS;
const MAX_NAME = 40;
const MAX_TEXT = 300;
const MAX_TIME_CHARS = 40;
const COUNTS = ['listed', 'created', 'requeued', 'closed', 'failed'] as const;

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

function parseLast(value: unknown): FeedLastRun | undefined {
  if (!isRecord(value)) return undefined;
  const { at, ok, error } = value;
  if (!isText(at, MAX_TIME_CHARS) || Number.isNaN(Date.parse(at)) || typeof ok !== 'boolean') return undefined;
  if (error !== undefined && !isText(error, MAX_TEXT)) return undefined;
  if (!COUNTS.every((name) => isCount(value[name]))) return undefined;
  return {
    at,
    ok,
    ...(error === undefined ? {} : { error }),
    listed: value['listed'] as number,
    created: value['created'] as number,
    requeued: value['requeued'] as number,
    closed: value['closed'] as number,
    failed: value['failed'] as number,
  };
}

function parseFeed(value: unknown): MachineFeed | undefined {
  if (!isRecord(value)) return undefined;
  const { id, name, everyMs, paused, runNow, problem } = value;
  if (!isFeedId(id) || !isText(name, MAX_NAME) || name === '') return undefined;
  if (!isCount(everyMs) || typeof paused !== 'boolean' || typeof runNow !== 'boolean') return undefined;
  if (problem !== undefined && !isText(problem, MAX_TEXT)) return undefined;
  const last = value['last'] === undefined ? undefined : parseLast(value['last']);
  if (value['last'] !== undefined && last === undefined) return undefined;
  return {
    id,
    name,
    everyMs,
    paused,
    runNow,
    ...(problem === undefined ? {} : { problem }),
    ...(last === undefined ? {} : { last }),
  };
}

/**
 * The feeds in a decoded document, or undefined when it is unreadable: not an object, `feeds` not a list or longer than
 * the cap. A feed of the wrong shape is dropped without losing the others, and other keys are ignored.
 */
export function parseMachineFeeds(json: unknown): MachineFeeds | undefined {
  if (!isRecord(json) || !Array.isArray(json['feeds'])) return undefined;
  const entries: unknown[] = json['feeds'];
  if (entries.length > MAX_MACHINE_FEEDS) return undefined;
  return { feeds: entries.flatMap((entry) => parseFeed(entry) ?? []) };
}

/** The one document the feeds are sealed as, and the bytes their blind index is made of: known fields only, in a fixed order. */
export function machineFeedsJson(feeds: MachineFeeds): string {
  return JSON.stringify({
    feeds: feeds.feeds.map(({ id, name, everyMs, paused, runNow, problem, last }) => ({
      id,
      name,
      everyMs,
      paused,
      runNow,
      ...(problem === undefined ? {} : { problem }),
      ...(last === undefined
        ? {}
        : {
            last: {
              at: last.at,
              ok: last.ok,
              ...(last.error === undefined ? {} : { error: last.error }),
              listed: last.listed,
              created: last.created,
              requeued: last.requeued,
              closed: last.closed,
              failed: last.failed,
            },
          }),
    })),
  });
}

/** What is wrong with feeds the board would not take, or undefined; the sender checks before it seals. */
export function feedsProblem(feeds: MachineFeeds): string | undefined {
  if (feeds.feeds.length > MAX_MACHINE_FEEDS) return `more than ${MAX_MACHINE_FEEDS} feeds`;
  const kept = parseMachineFeeds(JSON.parse(machineFeedsJson(feeds)));
  if (kept === undefined || machineFeedsJson(kept) !== machineFeedsJson(feeds))
    return 'an entry that is not of its shape: an id, a name, a count, a time or a text';
  return undefined;
}
