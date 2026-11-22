import { randomBytes } from 'node:crypto';
import { parseFeedRequest } from '@agent-board/shared';
import type { Backend, MachineFeed, MachineFeeds } from '@agent-board/shared';
import { errorText } from '../output/text.mts';
import { isFeedName, loadFeeds } from './config.mts';
import type { FeedStore } from './store.mts';

export interface FeedsBoardDeps {
  backend: Pick<Backend, 'checkFeeds' | 'setFeeds' | 'feedRequests' | 'ackFeedRequests'>;
  machine: string;
  configFile: string;
  store: FeedStore;
  log: (line: string) => void;
}

const MAX_PROBLEM = 300;

// The id of a feed, made and kept the first time it is needed.
function idOf(store: FeedStore, name: string): string {
  const state = store.read(name);
  if (state.id !== undefined) return state.id;
  const id = randomBytes(8).toString('hex');
  store.write(name, { ...state, id });
  return id;
}

/** What the board shows of this machine's feeds: every entry of config.json, a broken one with its problem. */
export function machineFeeds(configFile: string, store: FeedStore): MachineFeeds {
  const { feeds, feedErrors } = loadFeeds(configFile);
  const working = feeds.map((feed): MachineFeed => {
    const id = idOf(store, feed.name);
    const { paused, runNow, last } = store.read(feed.name);
    return {
      id,
      name: feed.name,
      everyMs: feed.everyMs,
      paused,
      runNow,
      ...(last === undefined
        ? {}
        : {
            last: {
              at: last.at,
              ok: last.ok,
              ...(last.error === undefined ? {} : { error: last.error }),
              ...last.counts,
            },
          }),
    };
  });
  const broken = Object.entries(feedErrors)
    .filter(([name]) => isFeedName(name))
    .map(([name, problem]): MachineFeed => ({
      id: idOf(store, name),
      name,
      everyMs: 0,
      paused: false,
      runNow: false,
      problem: problem.slice(0, MAX_PROBLEM),
    }));
  return { feeds: [...working, ...broken] };
}

/** Sends this machine's feeds to the board when the board holds another version of them. Never throws. */
export async function publishFeeds(deps: FeedsBoardDeps): Promise<void> {
  try {
    const feeds = machineFeeds(deps.configFile, deps.store);
    if ((await deps.backend.checkFeeds(deps.machine, feeds)) !== 'stale') return;
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
        const name = names.find((candidate) => deps.store.read(candidate).id === parsed?.id);
        if (parsed === undefined || name === undefined) continue;
        const state = deps.store.read(name);
        if (parsed.action === 'pause') deps.store.write(name, { ...state, paused: true });
        if (parsed.action === 'resume') deps.store.write(name, { ...state, paused: false });
        if (parsed.action === 'run') deps.store.write(name, { ...state, runNow: true });
        deps.log(`FEED ${name} ${parsed.action} from the board`);
      }
      await deps.backend.ackFeedRequests(requests);
    }
  } catch (error) {
    deps.log(`WARN feed requests not applied: ${errorText(error)}`);
  }
  await publishFeeds(deps);
}
