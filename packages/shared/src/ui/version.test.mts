import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ContractError } from '../contract.mts';
import { parseUiApiHeader } from './version.mts';

describe('parseUiApiHeader', () => {
  it('reads no header as null', () => {
    assert.equal(parseUiApiHeader(undefined), null);
  });

  it('reads a positive integer', () => {
    assert.equal(parseUiApiHeader('1'), 1);
    assert.equal(parseUiApiHeader(' 12 '), 12);
  });

  for (const value of ['01', '1.5', 'abc', '', '0', '-1', '1,2']) {
    it(`refuses ${JSON.stringify(value)}`, () => {
      assert.throws(() => parseUiApiHeader(value), ContractError);
    });
  }
});
