// What the Agents page shows of the board's agent definitions: what every machine reports of each one in its catalogue.
// Read only: the CLI's `board agents push` is the one writer.
import { INVALID_VALUE } from '@agent-board/shared';
import { shownName, type OpenedCatalog, type SharedAgentView } from '@agent-board/shared/ui';

/** The first 12 hex digits of a hash, as `board agents` prints it. */
export const shortHash = (hash: string): string => hash.slice(0, 12);

/** What one machine has of the board's agents, from its catalogue. */
export interface MachineAgents {
  machine: string;
  // False when the catalogue has no agents part: a CLI from before shared agents, or a catalogue that did not open.
  reports: boolean;
  // The version of the board's definitions it applied last; null when none.
  version: number | null;
  hashes: Record<string, string>;
  replaced: string[];
}

/** Every machine with a catalogue, by name; revoked machines have none. */
export function machineAgents(catalogs: readonly OpenedCatalog[]): MachineAgents[] {
  return catalogs.map(({ name, catalog }) => ({
    machine: shownName(name) ?? INVALID_VALUE,
    reports: catalog?.agents !== undefined,
    version: catalog?.agents?.version ?? null,
    hashes: catalog?.agents?.hashes ?? {},
    replaced: catalog?.agents?.replaced ?? [],
  }));
}

export type AgentOnMachine =
  { kind: 'silent' } | { kind: 'same' } | { kind: 'missing' } | { kind: 'other'; hash: string };

/** Whether a machine runs exactly the board's definition of an agent, another one, or none. */
export function agentOnMachine(machine: MachineAgents, agent: Pick<SharedAgentView, 'name' | 'hash'>): AgentOnMachine {
  if (!machine.reports) return { kind: 'silent' };
  const hash = machine.hashes[agent.name];
  if (hash === undefined) return { kind: 'missing' };
  return hash === agent.hash ? { kind: 'same' } : { kind: 'other', hash };
}
