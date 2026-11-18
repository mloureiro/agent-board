import { generateDataKey, wrapDataKey, type KeySlot } from '@agent-board/shared';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { appUsers } from './db/schema';
import { buildServer } from './server';
import { caller, testConfig, useTestDb } from './test/helpers';

const { db, admin } = await useTestDb();

const KEY_A = '0573c0a7b6879764';
const KEY_B = 'ffffffffffffffff';

let wrapped: string;
beforeAll(async () => {
  wrapped = await wrapDataKey(generateDataKey(), generateDataKey());
});

const passphrase = (): KeySlot => ({
  kind: 'passphrase',
  kdf: 'argon2id',
  m: 65536,
  t: 3,
  p: 1,
  salt: 'A'.repeat(22),
  wrapped,
});
const recovery = (): KeySlot => ({ kind: 'recovery', wrapped });

describe('keys router', () => {
  it('has no key before setup', async () => {
    const jascha = caller(db);
    expect(await jascha.keys.get()).toBeNull();
    expect(await jascha.me()).toEqual({ username: 'jascha', keyId: null });
  });

  it('stores the key once and returns it, with the key id on me', async () => {
    const jascha = caller(db);
    await jascha.keys.setup({ keyId: KEY_A, slots: [passphrase(), recovery()] });
    expect(await jascha.keys.get()).toEqual({ keyId: KEY_A, slots: [passphrase(), recovery()] });
    expect(await jascha.me()).toEqual({ username: 'jascha', keyId: KEY_A });
  });

  it('refuses a second setup, even with the same key id, and keeps the first', async () => {
    const jascha = caller(db);
    await jascha.keys.setup({ keyId: KEY_A, slots: [passphrase()] });
    await expect(jascha.keys.setup({ keyId: KEY_B, slots: [passphrase(), recovery()] })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(jascha.keys.setup({ keyId: KEY_A, slots: [passphrase()] })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await jascha.keys.get()).toEqual({ keyId: KEY_A, slots: [passphrase()] });
  });

  it('of two concurrent setups, exactly one wins', async () => {
    const jascha = caller(db);
    await jascha.me();
    const results = await Promise.allSettled([
      jascha.keys.setup({ keyId: KEY_A, slots: [passphrase()] }),
      jascha.keys.setup({ keyId: KEY_B, slots: [passphrase()] }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected');
    expect(lost).toMatchObject({ reason: { code: 'CONFLICT' } });
    const winner = results[0]?.status === 'fulfilled' ? KEY_A : KEY_B;
    expect((await jascha.keys.get())?.keyId).toBe(winner);
  });

  it('replaces the slots of the existing key and nothing else', async () => {
    const jascha = caller(db);
    await jascha.keys.setup({ keyId: KEY_A, slots: [passphrase()] });
    await jascha.keys.replaceSlots({ keyId: KEY_A, slots: [{ ...passphrase(), t: 4 } as KeySlot, recovery()] });
    expect(await jascha.keys.get()).toEqual({ keyId: KEY_A, slots: [{ ...passphrase(), t: 4 }, recovery()] });
  });

  it('refuses to replace slots before setup or under another key id', async () => {
    const jascha = caller(db);
    await expect(jascha.keys.replaceSlots({ keyId: KEY_A, slots: [passphrase()] })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('not set up'),
    });
    await jascha.keys.setup({ keyId: KEY_A, slots: [passphrase()] });
    await expect(jascha.keys.replaceSlots({ keyId: KEY_B, slots: [passphrase(), recovery()] })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('does not match'),
    });
    expect(await jascha.keys.get()).toEqual({ keyId: KEY_A, slots: [passphrase()] });
  });

  it('rejects malformed input with BAD_REQUEST and stores nothing', async () => {
    const jascha = caller(db);
    const bad: unknown[] = [
      { keyId: 'nothex', slots: [passphrase()] },
      { keyId: KEY_A, slots: [] },
      { keyId: KEY_A, slots: [recovery()] },
      { keyId: KEY_A, slots: [passphrase(), passphrase()] },
      { keyId: KEY_A, slots: [{ ...passphrase(), m: 4_000_000 }] },
      { keyId: KEY_A, slots: [{ ...passphrase(), wrapped: 'abw1.x' }] },
      { keyId: KEY_A, slots: [{ ...passphrase(), extra: true }] },
    ];
    for (const input of bad) {
      await expect(jascha.keys.setup(input as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    await expect(jascha.keys.replaceSlots({ keyId: KEY_A, slots: [] as never })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(await jascha.keys.get()).toBeNull();
  });

  it('the database refuses a key id without slots or slots without a key id', async () => {
    await caller(db).machines.issue({ name: 'laptop' });
    await expect(admin.update(appUsers).set({ keyId: KEY_A })).rejects.toThrow();
    await expect(admin.update(appUsers).set({ keySlots: [passphrase()] })).rejects.toThrow();
  });

  it('the machine API version carries the owner’s key id, or null', async () => {
    const jascha = caller(db);
    const app = await buildServer(testConfig, db);
    const token = (await jascha.machines.issue({ name: 'laptop' })).token;
    const version = async () =>
      (
        await app.inject({
          method: 'POST',
          url: '/api/machine/version',
          headers: { authorization: `Bearer ${token}` },
          payload: {},
        })
      ).json().result;
    expect(await version()).toMatchObject({ owner: 'jascha', keyId: null });
    await jascha.keys.setup({ keyId: KEY_A, slots: [passphrase()] });
    expect(await version()).toMatchObject({ owner: 'jascha', keyId: KEY_A });
  });

  it('keeps one user’s key apart from another’s', async () => {
    const [alice, bob] = [caller(db, 'alice'), caller(db, 'bob')];
    await alice.keys.setup({ keyId: KEY_A, slots: [passphrase()] });
    expect(await bob.keys.get()).toBeNull();
    await bob.keys.setup({ keyId: KEY_B, slots: [passphrase(), recovery()] });
    expect(await alice.keys.get()).toEqual({ keyId: KEY_A, slots: [passphrase()] });
    await expect(bob.keys.replaceSlots({ keyId: KEY_A, slots: [passphrase()] })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await admin.select({ id: appUsers.keyId }).from(appUsers).where(eq(appUsers.username, 'alice'))).toEqual([
      { id: KEY_A },
    ]);
    expect(await admin.execute(sql`select count(*)::int as n from app_user where key_id is not null`)).toMatchObject({
      rows: [{ n: 2 }],
    });
  });
});
