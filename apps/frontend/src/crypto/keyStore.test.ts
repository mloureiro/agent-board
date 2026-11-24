import { describe, expect, it } from 'vitest';
import { createKeySetup } from './unlocker';
import { createMemoryKeyStore } from '../test/memoryKeyStore';
import { inspectStoredKeys } from './keyStore';

async function keysFor(owner: string) {
  return (await createKeySetup({ owner, passphrase: 'correct horse battery staple', kdf: { m: 8192, t: 1, p: 1 } }))
    .keys;
}

describe('key store', () => {
  it('hands back keys that belong to this user and this key id', async () => {
    const keys = await keysFor('jascha');
    const store = createMemoryKeyStore(keys);
    const check = await inspectStoredKeys(store, { username: 'jascha', keyId: keys.keyId });
    expect(check).toMatchObject({ kind: 'usable', keys: { owner: 'jascha', keyId: keys.keyId } });
    expect(check.kind === 'usable' && check.keys.enc).toBe(keys.enc);
  });

  it('keeps an entry the board no longer matches, and says what it holds (a faked key reset)', async () => {
    const keys = await keysFor('jascha');
    for (const me of [
      { username: 'someone-else', keyId: keys.keyId },
      { username: 'jascha', keyId: '0123456789abcdef' },
      { username: 'jascha', keyId: null },
    ]) {
      const store = createMemoryKeyStore(keys);
      expect(await inspectStoredKeys(store, me)).toEqual({
        kind: 'changed',
        held: { owner: 'jascha', keyId: keys.keyId },
      });
      expect(await store.load(), JSON.stringify(me)).toMatchObject({ owner: 'jascha', keyId: keys.keyId });
    }
  });

  it('says there is nothing when nothing is stored, and drops an entry that is not keys', async () => {
    expect(await inspectStoredKeys(createMemoryKeyStore(), { username: 'jascha', keyId: null })).toEqual({
      kind: 'none',
    });
    const damaged = createMemoryKeyStore();
    await damaged.save({ owner: 'jascha', keyId: 'a'.repeat(16), enc: 'x', transcript: 'y' } as never);
    expect(await inspectStoredKeys(damaged, { username: 'jascha', keyId: 'a'.repeat(16) })).toEqual({ kind: 'none' });
    expect(await damaged.load()).toBeUndefined();
  });

  it('keeps nothing but the derived keys and ids', async () => {
    const keys = await keysFor('jascha');
    const store = createMemoryKeyStore();
    await store.save(keys);
    expect(Object.keys((await store.load()) ?? {}).sort()).toEqual(['enc', 'keyId', 'owner', 'transcript']);
    await store.clear();
    expect(await store.load()).toBeUndefined();
  });
});
