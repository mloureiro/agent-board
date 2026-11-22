import { errorText } from '../output/text.mts';
import { loadFeeds } from './config.mts';
import { isFeedDue, runFeed } from './run.mts';
import type { FeedRunDeps } from './run.mts';

export interface FeedJob {
  key: string;
  job: () => Promise<void>;
}

/** The runs of the feeds that are due, one job each, from config.json as it is now. */
export function dueFeedJobs(
  deps: FeedRunDeps,
  configFile: string,
  afterRun: () => Promise<void> = () => Promise.resolve(),
): FeedJob[] {
  let loaded;
  try {
    loaded = loadFeeds(configFile);
  } catch (error) {
    deps.log(`WARN feeds not read: ${errorText(error)}`);
    return [];
  }
  const now = deps.now();
  return loaded.feeds
    .filter((feed) => isFeedDue(feed, deps.store, now))
    .map((feed) => ({
      key: `feed:${feed.name}`,
      job: async () => {
        if ((await runFeed(deps, feed)) !== undefined) await afterRun();
      },
    }));
}
