import { errorText } from '../output/text.mts';
import { loadSources } from './config.mts';
import { isSourceDue, runSource } from './run.mts';
import type { SourceRunDeps } from './run.mts';

export interface SourceJob {
  key: string;
  job: () => Promise<void>;
}

/** The runs of the sources that are due, one job each, from config.json as it is now. */
export function dueSourceJobs(deps: SourceRunDeps, configFile: string): SourceJob[] {
  let loaded;
  try {
    loaded = loadSources(configFile);
  } catch (error) {
    deps.log(`WARN sources not read: ${errorText(error)}`);
    return [];
  }
  const now = deps.now();
  return loaded.sources
    .filter((source) => isSourceDue(source, deps.store, now))
    .map((source) => ({
      key: `source:${source.name}`,
      job: async () => void (await runSource(deps, source)),
    }));
}
