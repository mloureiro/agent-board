import { openLinkRules, sealLinkRules } from '@agent-board/shared';
import type { LinkRule } from '@agent-board/shared';
import { describe, expect, it } from 'vitest';
import { linkRules } from './db/schema';
import { caller, useTestDb } from './test/helpers';
import { sealed, sealerFor } from './test/sealed';

const { db, admin } = await useTestDb();

const STORY: LinkRule = { pattern: 'sc-(\\d+)', url: 'https://app.shortcut.com/acme/story/$1' };

/** What the browser sends: the next version sealed under its own binding. */
async function body(version: number, rules: LinkRule[] = [STORY], seal = sealed.seal) {
  return { document: await sealLinkRules(seal, { version, rules }), version, expectedVersion: version - 1 };
}

describe('links.get and links.set', () => {
  it('is null before the first save, then serves the sealed document with its version and time', async () => {
    expect(await caller(db).links.get()).toBeNull();
    const before = Date.now();
    const sent = await body(1);
    await caller(db).links.set(sent);
    const read = await caller(db).links.get();
    expect(read).toMatchObject({ version: 1, document: sent.document });
    expect(read?.updatedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(await openLinkRules(sealed.open, 1, read?.document ?? '')).toEqual({ version: 1, rules: [STORY] });
    const [row] = await admin.select().from(linkRules);
    expect(row).toMatchObject({ owner: 'jascha', version: 1 });
    expect(JSON.stringify(row)).not.toContain('shortcut');
  });

  it('is compare-and-set: a save against a version that moved on is a CONFLICT, and the stored one stays', async () => {
    const api = caller(db);
    await api.links.set(await body(1));
    const second = await body(2, [STORY, { pattern: 'PR#(\\d+)', url: 'https://github.com/acme/app/pull/$1' }]);
    await api.links.set(second);
    // Another tab opened version 1 and saves its change on top of it.
    await expect(api.links.set(await body(2, []))).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringMatching(/holds version 2 of the link rules, not 1/) as unknown,
    });
    await expect(api.links.set(await body(1, []))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await api.links.get()).toMatchObject({ version: 2, document: second.document });
  });

  it('is a CONFLICT to save a first version when one is stored', async () => {
    const api = caller(db);
    await api.links.set(await body(1));
    await expect(api.links.set(await body(1, []))).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringMatching(/holds version 1 of the link rules, not none/) as unknown,
    });
  });

  it('refuses a version that is not expectedVersion + 1 and a plain document', async () => {
    const api = caller(db);
    const sentDocument = (await body(1)).document;
    for (const bad of [
      { document: sentDocument, version: 3, expectedVersion: 1 },
      { document: sentDocument, version: 1, expectedVersion: -1 },
      { document: sentDocument, version: 0, expectedVersion: -1 },
      { document: JSON.stringify({ version: 1, rules: [] }), version: 1, expectedVersion: 0 },
    ])
      await expect(api.links.set(bad)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await admin.select().from(linkRules)).toEqual([]);
  });

  it("keeps each user's document to themselves", async () => {
    await caller(db).links.set(await body(1));
    expect(await caller(db, 'other').links.get()).toBeNull();
    await caller(db, 'other').links.set(await body(1, [], sealerFor('other').seal));
    expect((await admin.select().from(linkRules)).map(({ owner }) => owner).sort()).toEqual(['jascha', 'other']);
    expect(await caller(db).links.get()).toMatchObject({ version: 1 });
  });
});
