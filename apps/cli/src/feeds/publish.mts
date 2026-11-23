import { parseFeedRequest } from '@agent-board/shared';
import type { Backend, MachineFeed, MachineFeeds } from '@agent-board/shared';
import { errorText } from '../output/text.mts';
import { isFeedName, loadFeeds } from './config.mts';
import { runAsked } from './run.mts';
import type { FeedStore } from './store.mts';

export interface FeedsBoardDeps {
  backend: Pick<Backend, 'checkFeeds' | 'setFeeds' | 'feedRequests' | 'ackFeedRequests'>;
  machine: string;
  configFile: string;
  store: FeedStore;
  now: () => Date;
  log: (line: string) => void;
}

const MAX_PROBLEM = 300;

/** What the board shows of this machine's feeds: every entry of config.json, a broken one with its problem. */
export function machineFeeds(configFile: string, store: FeedStore): MachineFeeds {
  const { feeds, feedErrors } = loadFeeds(configFile);
  const working = feeds.map((feed): MachineFeed => {
    const control = store.updateControl(feed.name, {});
    const record = store.readRecord(feed.name);
    const { last } = record;
    return {
      id: control.id,
      name: feed.name,
      everyMs: feed.everyMs,
      paused: control.paused,
      runNow: runAsked(control, record),
      ...(last === undefined
        ? {}
        : {
            last: {
              at: last.at,
              ok: last.ok,
              ...(last.error === undefined ? {} : { error: last.error }),
              listed: last.counts.listed,
              created: last.counts.created,
              requeued: last.counts.requeued,
              closed: last.counts.closed,
              failed: last.counts.failed,
            },
          }),
    };
  });
  const broken = Object.entries(feedErrors)
    .filter(([name]) => isFeedName(name))
    .map(([name, problem]): MachineFeed => ({
      id: store.updateControl(name, {}).id,
      name,
      everyMs: 0,
      paused: false,
      runNow: false,
      problem: problem.slice(0, MAX_PROBLEM),
    }));
  return { feeds: [...working, ...broken] };
}

/**
 * Sends this machine's feeds to the board when the board holds another version of them, or whenever the server has the
 * feature with `always`, for a process that cannot know what the board holds. Never throws.
 */
export async function publishFeeds(deps: FeedsBoardDeps, always = false): Promise<void> {
  try {
    const feeds = machineFeeds(deps.configFile, deps.store);
    const held = await deps.backend.checkFeeds(deps.machine, feeds);
    if (held === 'unsupported' || (held === 'current' && !always)) return;
    await deps.backend.setFeeds(deps.machine, feeds);
  } catch (error) {
    deps.log(`WARN feeds not sent to the board: ${errorText(error)}`);
  }
}

/**
 * Applies the user's requests from the board to this machine's feeds: a pause, a resume, or a run on the watch unit's next
 * look. A request for a feed this machine no longer has is acknowledged too. Then sends the feeds. Never throws.
 */
export async function applyFeedRequests(deps: FeedsBoardDeps): Promise<void> {
  try {
    const requests = await deps.backend.feedRequests();
    if (requests.length > 0) {
      const { feeds, feedErrors } = loadFeeds(deps.configFile);
      const names = [...feeds.map(({ name }) => name), ...Object.keys(feedErrors).filter(isFeedName)];
      for (const request of requests) {
        const parsed = parseFeedRequest(request);
        const name = names.find((candidate) => deps.store.readControl(candidate).id === parsed?.id);
        if (parsed === undefined || name === undefined) continue;
        if (parsed.action === 'pause') deps.store.updateControl(name, { paused: true });
        if (parsed.action === 'resume') deps.store.updateControl(name, { paused: false });
        if (parsed.action === 'run') deps.store.updateControl(name, { runRequestedAt: deps.now().toISOString() });
        deps.log(`FEED ${name} ${parsed.action} from the board`);
      }
      await deps.backend.ackFeedRequests(requests);
    }
  } catch (error) {
    deps.log(`WARN feed requests not applied: ${errorText(error)}`);
  }
  await publishFeeds(deps);
}
