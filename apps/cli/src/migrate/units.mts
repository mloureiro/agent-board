import { AGENT_NAMES, agentFile, launchAgentsDirectory } from '../setup/launchd.mts';
import { REMOVED_UNIT_FILES, renderUnits, unitDirectory } from '../setup/setup.mts';

export interface UnitFiles {
  dir: string;
  names: string[];
}

// The unit files a migration may touch: the names `board setup` writes and the ones it removes, where the platform keeps them.
export function unitFilesOf(platform: string, env: Record<string, string | undefined>, home: string): UnitFiles {
  if (platform === 'darwin') return { dir: launchAgentsDirectory(home), names: AGENT_NAMES.map(agentFile) };
  if (platform === 'linux') {
    const rendered = renderUnits({ flock: 'flock', command: () => [] }).map((unit) => unit.file);
    return { dir: unitDirectory(env), names: [...rendered, ...REMOVED_UNIT_FILES] };
  }
  return { dir: '', names: [] };
}
