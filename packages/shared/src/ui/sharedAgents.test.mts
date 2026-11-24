import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agentHash } from '../index.mts';
import { viewSharedAgent } from './sharedAgents.mts';

const REVIEWER = {
  description: 'Reviews',
  tools: ['Read', 'Grep'],
  allowedTools: ['Read', 'Bash(git log *)'],
  env: ['GITHUB_TOKEN'],
  version: '1.2.0',
};

describe('viewSharedAgent', () => {
  it('reads a definition with the flags the CLI prints and the hash the machines report', async () => {
    const view = await viewSharedAgent('reviewer', REVIEWER);
    assert.partialDeepStrictEqual(view, {
      name: 'reviewer',
      description: 'Reviews',
      version: '1.2.0',
      prompt: null,
      tools: ['Read', 'Grep'],
      disallowedTools: [],
      mcpServers: [],
      problems: [],
      hash: await agentHash(REVIEWER),
      flags: {
        broad: [{ rule: 'Read', reason: 'reads every file the deny list does not name' }],
        secrets: ['GITHUB_TOKEN'],
        emptyDenyList: true,
        deadTools: ['Bash'],
      },
    });
    assert.deepEqual(JSON.parse(view.definition), REVIEWER);
  });

  it('shows a key of the wrong shape empty and names it, as a machine refuses it', async () => {
    const view = await viewSharedAgent('odd', { description: 3, tools: 'Read', env: ['A', 1] } as never);
    assert.partialDeepStrictEqual(view, { description: null, tools: [], env: [] });
    assert.deepEqual(view.problems, [
      'tools is not a list of strings',
      'env is not a list of strings',
      'description is not text',
      'description is missing',
      'tools is empty',
    ]);
  });
});
