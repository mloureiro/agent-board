import { randomBytes } from 'node:crypto';
import { parseSourceRequest } from '@agent-board/shared';
import type { Backend, MachineSource, MachineSources } from '@agent-board/shared';
import { errorText } from '../output/text.mts';
import { isSourceName, loadSources } from './config.mts';
import type { SourceStore } from './store.mts';

export interface SourcesBoardDeps {
  backend: Pick<Backend, 'checkSources' | 'setSources' | 'sourceRequests' | 'ackSourceRequests'>;
  machine: string;
  configFile: string;
  store: SourceStore;
  log: (line: string) => void;
}

const MAX_PROBLEM = 300;

// The id of a source, made and kept the first time it is needed.
function idOf(store: SourceStore, name: string): string {
  const state = store.read(name);
  if (state.id !== undefined) return state.id;
  const id = randomBytes(8).toString('hex');
  store.write(name, { ...state, id });
  return id;
}

/** What the board shows of this machine's sources: every entry of config.json, a broken one with its problem. */
export function machineSources(configFile: string, store: SourceStore): MachineSources {
  const { sources, sourceErrors } = loadSources(configFile);
  const working = sources.map((source): MachineSource => {
    const id = idOf(store, source.name);
    const { paused, runNow, last } = store.read(source.name);
    return {
      id,
      name: source.name,
      everyMs: source.everyMs,
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
  const broken = Object.entries(sourceErrors)
    .filter(([name]) => isSourceName(name))
    .map(([name, problem]): MachineSource => ({
      id: idOf(store, name),
      name,
      everyMs: 0,
      paused: false,
      runNow: false,
      problem: problem.slice(0, MAX_PROBLEM),
    }));
  return { sources: [...working, ...broken] };
}

/** Sends this machine's sources to the board when the board holds another version of them. Never throws. */
export async function publishSources(deps: SourcesBoardDeps): Promise<void> {
  try {
    const sources = machineSources(deps.configFile, deps.store);
    if ((await deps.backend.checkSources(deps.machine, sources)) !== 'stale') return;
    await deps.backend.setSources(deps.machine, sources);
  } catch (error) {
    deps.log(`WARN sources not sent to the board: ${errorText(error)}`);
  }
}

/**
 * Applies the user's requests from the board to this machine's sources: a pause, a resume, or a run on the watch unit's next
 * look. A request for a source this machine no longer has is acknowledged too. Then sends the sources. Never throws.
 */
export async function applySourceRequests(deps: SourcesBoardDeps): Promise<void> {
  try {
    const requests = await deps.backend.sourceRequests();
    if (requests.length > 0) {
      const { sources, sourceErrors } = loadSources(deps.configFile);
      const names = [...sources.map(({ name }) => name), ...Object.keys(sourceErrors).filter(isSourceName)];
      for (const request of requests) {
        const parsed = parseSourceRequest(request);
        const name = names.find((candidate) => deps.store.read(candidate).id === parsed?.id);
        if (parsed === undefined || name === undefined) continue;
        const state = deps.store.read(name);
        if (parsed.action === 'pause') deps.store.write(name, { ...state, paused: true });
        if (parsed.action === 'resume') deps.store.write(name, { ...state, paused: false });
        if (parsed.action === 'run') deps.store.write(name, { ...state, runNow: true });
        deps.log(`SOURCE ${name} ${parsed.action} from the board`);
      }
      await deps.backend.ackSourceRequests(requests);
    }
  } catch (error) {
    deps.log(`WARN source requests not applied: ${errorText(error)}`);
  }
  await publishSources(deps);
}
