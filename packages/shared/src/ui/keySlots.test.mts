import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeDataKey, deriveKeys, open, seal, type Keys } from '../crypto.mts';
import { parseKeySetup } from '../keys.mts';
import { testArgon2id } from './argon2idForTests.mts';
import { KeyError, PRODUCTION_KDF, WrongSecretError, type KdfParams } from './kdf.mts';
import { createUnlocker } from './keySlots.mts';
import { normalizePassphrase, passphraseProblem } from './passphrase.mts';

const { createKeySetup, exportDataKey, replacePassphrase, unlockKeys } = createUnlocker(testArgon2id);

// The smallest cost the board accepts; the production cost is for one test below.
const FAST: KdfParams = { m: 8192, t: 1, p: 1 };
const OWNER = 'jascha';
const PASSPHRASE = 'correct horse battery staple';

async function sealTitle(keys: Keys): Promise<string> {
  return seal(keys, 'title', 'task:abc', 'hello');
}

const openTitle = (keys: Keys, envelope: string): Promise<string> => open(keys, 'title', 'task:abc', envelope);

describe('key setup', () => {
  it('stores a passphrase slot and a recovery slot that the board accepts', async () => {
    const { setup } = await createKeySetup({ owner: OWNER, passphrase: PASSPHRASE, kdf: FAST });
    assert.deepEqual(parseKeySetup(setup), setup);
    assert.deepEqual(
      setup.slots.map((slot) => slot.kind),
      ['passphrase', 'recovery'],
    );
  });

  it('uses the production Argon2id cost unless told otherwise', async () => {
    assert.deepEqual(PRODUCTION_KDF, { m: 65_536, t: 3, p: 1 });
    const { setup } = await createKeySetup({ owner: OWNER, passphrase: PASSPHRASE });
    const [slot] = setup.slots;
    assert.ok(slot?.kind === 'passphrase');
    assert.deepEqual([slot.kdf, slot.m, slot.t, slot.p], ['argon2id', 65_536, 3, 1]);
  });

  it('unlocks with the passphrase to the keys it made', async () => {
    const { setup, keys } = await createKeySetup({ owner: OWNER, passphrase: PASSPHRASE, kdf: FAST });
    const unlocked = await unlockKeys({
      owner: OWNER,
      stored: setup,
      secret: { kind: 'passphrase', passphrase: PASSPHRASE },
    });
    assert.equal(unlocked.keyId, keys.keyId);
    assert.equal(keys.keyId, setup.keyId);
    assert.equal(await openTitle(unlocked, await sealTitle(keys)), 'hello');
  });

  it('unlocks with the recovery key as it was shown', async () => {
    const { setup, keys, recoveryKey } = await createKeySetup({ owner: OWNER, passphrase: PASSPHRASE, kdf: FAST });
    const unlocked = await unlockKeys({ owner: OWNER, stored: setup, secret: { kind: 'recovery', recoveryKey } });
    assert.equal(await openTitle(unlocked, await sealTitle(keys)), 'hello');
  });

  it('gives non-extractable keys', async () => {
    const { keys } = await createKeySetup({ owner: OWNER, passphrase: PASSPHRASE, kdf: FAST });
    assert.equal(keys.enc.extractable, false);
    await assert.rejects(globalThis.crypto.subtle.exportKey('raw', keys.enc));
  });

  it('refuses a wrong passphrase and a wrong recovery key without saying which part was wrong', async () => {
    const { setup } = await createKeySetup({ owner: OWNER, passphrase: PASSPHRASE, kdf: FAST });
    const other = await createKeySetup({ owner: OWNER, passphrase: PASSPHRASE, kdf: FAST });
    await assert.rejects(
      unlockKeys({ owner: OWNER, stored: setup, secret: { kind: 'passphrase', passphrase: 'not the passphrase' } }),
      WrongSecretError,
    );
    await assert.rejects(
      unlockKeys({ owner: OWNER, stored: setup, secret: { kind: 'recovery', recoveryKey: other.recoveryKey } }),
      WrongSecretError,
    );
    await assert.rejects(unlockKeys({ owner: OWNER, stored: setup, secret: { kind: 'passphrase', passphrase: 'x' } }), {
      message: 'Wrong passphrase or recovery key.',
    });
  });

  it('refuses a key id that is not the board’s', async () => {
    const { setup } = await createKeySetup({ owner: OWNER, passphrase: PASSPHRASE, kdf: FAST });
    await assert.rejects(
      unlockKeys({
        owner: OWNER,
        stored: { ...setup, keyId: '0000000000000000' },
        secret: { kind: 'passphrase', passphrase: PASSPHRASE },
      }),
      KeyError,
    );
  });

  for (const [name, params] of [
    ['m', { m: 262_145, t: 1, p: 1 }],
    ['m below the floor', { m: 1024, t: 1, p: 1 }],
    ['t', { m: 8192, t: 11, p: 1 }],
    ['p', { m: 8192, t: 1, p: 5 }],
  ] as const) {
    it(`refuses slot parameters outside the limits (${name}) before computing anything`, async () => {
      const { setup } = await createKeySetup({ owner: OWNER, passphrase: PASSPHRASE, kdf: FAST });
      const [slot, recovery] = setup.slots;
      const hostile = { ...setup, slots: [{ ...slot, ...params }, recovery] } as typeof setup;
      const started = Date.now();
      await assert.rejects(
        unlockKeys({ owner: OWNER, stored: hostile, secret: { kind: 'passphrase', passphrase: PASSPHRASE } }),
        { message: /more computing than this browser accepts/ },
      );
      assert.ok(Date.now() - started < 500);
    });
  }

  it('never calls the injected Argon2id for a slot outside the limits', async () => {
    let calls = 0;
    const counting = createUnlocker((options) => {
      calls += 1;
      return testArgon2id(options);
    });
    const { setup } = await createKeySetup({ owner: OWNER, passphrase: PASSPHRASE, kdf: FAST });
    const [slot, recovery] = setup.slots;
    const hostile = { ...setup, slots: [{ ...slot, t: 11 }, recovery] } as typeof setup;
    await assert.rejects(
      counting.unlockKeys({ owner: OWNER, stored: hostile, secret: { kind: 'passphrase', passphrase: PASSPHRASE } }),
      KeyError,
    );
    assert.equal(calls, 0);
  });
});

describe('a new passphrase', () => {
  it('after the recovery key replaces the passphrase slot and keeps the recovery slot as it was', async () => {
    const { setup, recoveryKey, keys } = await createKeySetup({ owner: OWNER, passphrase: PASSPHRASE, kdf: FAST });
    const newPassphrase = 'a different long passphrase';
    const replaced = await replacePassphrase({
      owner: OWNER,
      stored: setup,
      secret: { kind: 'recovery', recoveryKey },
      newPassphrase,
      kdf: FAST,
    });
    const stored = { keyId: setup.keyId, slots: replaced.slots };
    assert.deepEqual(parseKeySetup(stored), stored);
    assert.deepEqual(
      replaced.slots.map((slot) => slot.kind),
      ['passphrase', 'recovery'],
    );
    assert.deepEqual(replaced.slots[1], setup.slots[1]);
    assert.notDeepEqual(replaced.slots[0], setup.slots[0]);
    assert.equal(replaced.keys.keyId, keys.keyId);

    await assert.rejects(
      unlockKeys({ owner: OWNER, stored, secret: { kind: 'passphrase', passphrase: PASSPHRASE } }),
      WrongSecretError,
    );
    const withNew = await unlockKeys({
      owner: OWNER,
      stored,
      secret: { kind: 'passphrase', passphrase: newPassphrase },
    });
    assert.equal(await openTitle(withNew, await sealTitle(keys)), 'hello');
    const withRecovery = await unlockKeys({ owner: OWNER, stored, secret: { kind: 'recovery', recoveryKey } });
    assert.equal(await openTitle(withRecovery, await sealTitle(keys)), 'hello');
  });

  it('is refused when the current passphrase is wrong', async () => {
    const { setup } = await createKeySetup({ owner: OWNER, passphrase: PASSPHRASE, kdf: FAST });
    await assert.rejects(
      replacePassphrase({
        owner: OWNER,
        stored: setup,
        secret: { kind: 'passphrase', passphrase: 'nope' },
        newPassphrase: 'a different long passphrase',
        kdf: FAST,
      }),
      WrongSecretError,
    );
  });
});

describe('the data key for a machine', () => {
  it('is the abk1_ key that opens what the browser sealed', async () => {
    const { setup, keys } = await createKeySetup({ owner: OWNER, passphrase: PASSPHRASE, kdf: FAST });
    const line = await exportDataKey({ owner: OWNER, stored: setup, passphrase: PASSPHRASE });
    assert.match(line, /^abk1_/);
    const machine = await deriveKeys(decodeDataKey(line), OWNER);
    assert.equal(machine.keyId, keys.keyId);
    assert.equal(await openTitle(machine, await sealTitle(keys)), 'hello');
  });

  it('needs the right passphrase', async () => {
    const { setup } = await createKeySetup({ owner: OWNER, passphrase: PASSPHRASE, kdf: FAST });
    await assert.rejects(exportDataKey({ owner: OWNER, stored: setup, passphrase: 'nope' }), WrongSecretError);
  });
});

describe('passphrase strength', () => {
  it('asks for length and nothing else', () => {
    assert.match(passphraseProblem('short') ?? '', /at least 14/);
    assert.match(passphraseProblem('              ') ?? '', /at least 14/);
    assert.equal(passphraseProblem('aaaaaaaaaaaaaa'), null);
    assert.equal(passphraseProblem(PASSPHRASE), null);
  });
});

describe('the passphrase', () => {
  it('is normalised in one place, so setup, unlock, change and export treat a trailing space alike', async () => {
    const { setup, keys } = await createKeySetup({ owner: OWNER, passphrase: `${PASSPHRASE} `, kdf: FAST });
    for (const typed of [PASSPHRASE, `${PASSPHRASE} `, `  ${PASSPHRASE}\n`]) {
      const unlocked = await unlockKeys({
        owner: OWNER,
        stored: setup,
        secret: { kind: 'passphrase', passphrase: typed },
      });
      assert.equal(unlocked.keyId, keys.keyId, JSON.stringify(typed));
    }
    const changed = await replacePassphrase({
      owner: OWNER,
      stored: setup,
      secret: { kind: 'passphrase', passphrase: ` ${PASSPHRASE}` },
      newPassphrase: 'another long passphrase here ',
      kdf: FAST,
    });
    const next = { keyId: setup.keyId, slots: changed.slots };
    const unlocked = await unlockKeys({
      owner: OWNER,
      stored: next,
      secret: { kind: 'passphrase', passphrase: 'another long passphrase here' },
    });
    assert.equal(unlocked.keyId, keys.keyId);
    assert.match(
      await exportDataKey({ owner: OWNER, stored: next, passphrase: ' another long passphrase here' }),
      /^abk1_/,
    );
  });

  it('is counted as it is hashed: spaces around it do not make a short one long', () => {
    assert.equal(normalizePassphrase('  a b  '), 'a b');
    assert.notEqual(passphraseProblem(`${' '.repeat(10)}short${' '.repeat(10)}`), null);
    assert.equal(passphraseProblem(`${PASSPHRASE}   `), null);
  });
});
