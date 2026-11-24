import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KeyError } from './kdf.mts';
import { formatRecoveryKey, parseRecoveryKey, recoveryGroups, sameRecoveryText } from './recoveryKey.mts';

const bytes = () => globalThis.crypto.getRandomValues(new Uint8Array(32));

describe('recovery key', () => {
  it('is 14 groups of four from an alphabet without look-alikes', async () => {
    const text = await formatRecoveryKey(bytes());
    assert.match(text, /^([0-9A-HJKMNP-TV-Z]{4}-){13}[0-9A-HJKMNP-TV-Z]{4}$/);
    assert.equal(recoveryGroups(text).length, 14);
  });

  it('reads back to the same bytes, in any case and with or without dashes', async () => {
    const key = bytes();
    const text = await formatRecoveryKey(key);
    assert.deepEqual(await parseRecoveryKey(text), key);
    assert.deepEqual(await parseRecoveryKey(text.toLowerCase().replaceAll('-', ' ')), key);
    assert.deepEqual(await parseRecoveryKey(text.replaceAll('-', '')), key);
  });

  it('reads O, I and L as 0 and 1', async () => {
    const key = new Uint8Array(32);
    const text = await formatRecoveryKey(key);
    assert.ok(text.startsWith('0000-0000'));
    assert.deepEqual(await parseRecoveryKey(text.replaceAll('0', 'O')), key);
  });

  it('catches a mistyped character by its checksum', async () => {
    const text = await formatRecoveryKey(bytes());
    const wrong = text[0] === '2' ? '3' : '2';
    await assert.rejects(parseRecoveryKey(wrong + text.slice(1)), KeyError);
  });

  it('refuses text of the wrong length or alphabet', async () => {
    await assert.rejects(parseRecoveryKey(''), KeyError);
    await assert.rejects(parseRecoveryKey('ABCD-EFGH'), KeyError);
    await assert.rejects(parseRecoveryKey('U'.repeat(56)), KeyError);
  });

  it('compares a typed group to the shown one', () => {
    assert.equal(sameRecoveryText(' ab12 ', 'AB12'), true);
    assert.equal(sameRecoveryText('AB13', 'AB12'), false);
    assert.equal(sameRecoveryText('', ''), false);
  });
});
