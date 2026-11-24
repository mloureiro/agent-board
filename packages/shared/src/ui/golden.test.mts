import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fromBase64Url } from '../crypto.mts';
import type { KeySetup } from '../keys.mts';
import { testArgon2id } from './argon2idForTests.mts';
import { derivePassphraseKey } from './kdf.mts';
import { createUnlocker } from './keySlots.mts';

interface KeyFixture {
  owner: string;
  kdf: { m: number; t: number; p: number };
  passphrase: string;
  salt: string;
  wrappingKey: string;
  setup: { passphrase: string; recoveryKey: string; keyId: string; keySetup: KeySetup };
}

const fixture = JSON.parse(
  readFileSync(new URL('../__tests__/fixtures/ui-golden/keys.json', import.meta.url), 'utf8'),
) as KeyFixture;

const bytes = (text: string): Uint8Array => {
  const decoded = fromBase64Url(text);
  if (decoded === null) throw new Error('the fixture holds a value that is not base64url');
  return decoded;
};

const { openDataKey, unlockKeys } = createUnlocker(testArgon2id);

describe('the keys recorded from the browser', () => {
  it('derive the recorded wrapping key from the recorded passphrase and salt', async () => {
    const wrappingKey = await derivePassphraseKey(fixture.passphrase, bytes(fixture.salt), fixture.kdf, testArgon2id);
    assert.deepEqual(Array.from(wrappingKey), Array.from(bytes(fixture.wrappingKey)));
  });

  it('open the recorded key setup with the passphrase and with the recovery key to one data key and its key id', async () => {
    const { keySetup, passphrase, recoveryKey, keyId } = fixture.setup;
    const withPassphrase = await openDataKey(keySetup.slots, { kind: 'passphrase', passphrase });
    const withRecovery = await openDataKey(keySetup.slots, { kind: 'recovery', recoveryKey });
    assert.deepEqual(Array.from(withPassphrase), Array.from(withRecovery));
    for (const secret of [
      { kind: 'passphrase', passphrase },
      { kind: 'recovery', recoveryKey },
    ] as const)
      assert.equal((await unlockKeys({ owner: fixture.owner, stored: keySetup, secret })).keyId, keyId);
  });
});
