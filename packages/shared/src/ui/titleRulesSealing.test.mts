import { deriveKeys, generateDataKey, openTitleRules } from '../index.mts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openBoardTitleRules, openerFor } from './responses.mts';
import { sealTitleRulesInput } from './requests.mts';

describe('title rules sealing', () => {
  it('seals the next version so that the board document opens back to the rules', async () => {
    const keys = await deriveKeys(generateDataKey(), 'jascha');
    const rules = [{ pattern: 'pull/\\d+', icon: '🔀', instruction: 'The PR title.' }];
    const input = await sealTitleRulesInput(keys, rules, 3);
    assert.deepEqual([input.version, input.expectedVersion], [4, 3]);
    assert.deepEqual((await openTitleRules(openerFor(keys), 4, input.document))?.rules, rules);
    const board = await openBoardTitleRules(keys, { version: 4, document: input.document, updatedAt: 'now' });
    assert.deepEqual(board, { version: 4, updatedAt: 'now', rules });
  });

  it('leaves the rules null when the document does not open', async () => {
    const keys = await deriveKeys(generateDataKey(), 'jascha');
    const input = await sealTitleRulesInput(keys, [{ pattern: 'a', icon: '🔀' }], 1);
    const board = await openBoardTitleRules(keys, { version: 5, document: input.document, updatedAt: '' });
    assert.equal(board?.rules, null);
  });
});
