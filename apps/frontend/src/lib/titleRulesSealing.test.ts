import { deriveKeys, generateDataKey, openTitleRules } from '@agent-board/shared';
import { describe, expect, it } from 'vitest';
import { openBoardTitleRules, openerFor } from './opening';
import { sealTitleRulesInput } from './sealing';

describe('title rules sealing', () => {
  it('seals the next version so that the board document opens back to the rules', async () => {
    const keys = await deriveKeys(generateDataKey(), 'jascha');
    const rules = [{ pattern: 'pull/\\d+', icon: '🔀', instruction: 'The PR title.' }];
    const input = await sealTitleRulesInput(keys, rules, 3);
    expect([input.version, input.expectedVersion]).toEqual([4, 3]);
    expect((await openTitleRules(openerFor(keys), 4, input.document))?.rules).toEqual(rules);
    const board = await openBoardTitleRules(keys, { version: 4, document: input.document, updatedAt: 'now' });
    expect(board).toEqual({ version: 4, updatedAt: 'now', rules });
  });

  it('leaves the rules null when the document does not open', async () => {
    const keys = await deriveKeys(generateDataKey(), 'jascha');
    const input = await sealTitleRulesInput(keys, [{ pattern: 'a', icon: '🔀' }], 1);
    const board = await openBoardTitleRules(keys, { version: 5, document: input.document, updatedAt: '' });
    expect(board?.rules).toBeNull();
  });
});
