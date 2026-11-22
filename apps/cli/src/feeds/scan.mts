import { errorText } from '../output/text.mts';
import { parseConfig } from '../config/config.mts';
import { readConfigFile } from '../config/config-file.mts';
import { parseFeeds } from './config.mts';
import { isFeedDue, runFeed } from './run.mts';
import type { FeedRunDeps } from './run.mts';

export interface FeedJob {
  key: string;
  job: () => Promise<void>;
}

/** The runs of the feeds that are due, one job each, from config.json as it is now. */
export function dueFeedJobs(
  deps: Omit<FeedRunDeps, 'dirs'>,
  configFile: string,
  afterRun: () => Promise<void> = () => Promise.resolve(),
): FeedJob[] {
  let loaded;
  let dirs;
  try {
    const { raw } = readConfigFile(configFile);
    loaded = parseFeeds(raw['feeds']);
    dirs = parseConfig(raw).dirs;
  } catch (error) {
    deps.log(`WARN feeds not read: ${errorText(error)}`);
    return [];
  }
  const now = deps.now();
  return loaded.feeds
    .filter((feed) => isFeedDue(feed, deps.store.readControl(feed.name), deps.store.readRecord(feed.name), now))
    .map((feed) => ({
      key: `feed:${feed.name}`,
      job: async () => {
        if ((await runFeed({ ...deps, dirs }, feed)) !== undefined) await afterRun();
      },
    }));
}
