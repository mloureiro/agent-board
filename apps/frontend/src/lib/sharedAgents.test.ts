import { describe, expect, it } from 'vitest';
import { agentOnMachine, machineAgents } from './sharedAgents';

describe('agentOnMachine', () => {
  const [laptop, old, desktop] = machineAgents([
    {
      name: 'laptop',
      catalog: {
        models: [],
        skills: [],
        dirs: {},
        agents: { version: 2, hashes: { reviewer: 'a'.repeat(64) }, replaced: ['reviewer'] },
      },
    },
    { name: 'old', catalog: { models: [], skills: [], dirs: {} } },
    {
      name: 'desktop',
      catalog: { models: [], skills: [], dirs: {}, agents: { version: 1, hashes: {}, replaced: [] } },
    },
  ]);

  it('tells the board definition, another one, none, and a machine that does not report', () => {
    expect(laptop).toMatchObject({ machine: 'laptop', reports: true, version: 2, replaced: ['reviewer'] });
    expect(agentOnMachine(laptop!, { name: 'reviewer', hash: 'a'.repeat(64) })).toEqual({ kind: 'same' });
    expect(agentOnMachine(laptop!, { name: 'reviewer', hash: 'b'.repeat(64) })).toEqual({
      kind: 'other',
      hash: 'a'.repeat(64),
    });
    expect(agentOnMachine(desktop!, { name: 'reviewer', hash: 'a'.repeat(64) })).toEqual({ kind: 'missing' });
    expect(old).toMatchObject({ reports: false, version: null });
    expect(agentOnMachine(old!, { name: 'reviewer', hash: 'a'.repeat(64) })).toEqual({ kind: 'silent' });
  });
});
