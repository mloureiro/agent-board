import { describe, expect, it } from 'vitest';
import { createMemoryDraftStorage } from '../test/draftStorage';
import {
  answerSlot,
  createDraftStore,
  DRAFT_PREFIX,
  forkSlot,
  promptSlot,
  removeDrafts,
  replySlot,
  type DraftStorage,
} from './drafts';

const alice = { username: 'alice', keyId: 'k1' };
const questions = [
  {
    header: 'Tests',
    question: 'Add one?',
    multiSelect: false,
    options: [
      { label: 'Yes', description: '', recommended: true },
      { label: 'No', description: '' },
    ],
  },
];

describe('draft store', () => {
  it('round-trips a value under a key made of the user, the key id and the slot, one segment per part', () => {
    const storage = createMemoryDraftStorage();
    const store = createDraftStore({ username: 'a/b', keyId: 'k1' }, storage);
    store.write(replySlot('t1'), 'half a reply');
    expect([...storage.entries.keys()]).toEqual([`${DRAFT_PREFIX}a%2Fb/k1/reply:t1`]);
    expect(store.read(replySlot('t1'))).toBe('half a reply');
  });

  it('keeps each slot key and each identity apart', () => {
    const storage = createMemoryDraftStorage();
    createDraftStore(alice, storage).write(replySlot('t1'), 'one');
    expect(createDraftStore(alice, storage).read(replySlot('t2'))).toBeUndefined();
    expect(createDraftStore({ ...alice, username: 'bob' }, storage).read(replySlot('t1'))).toBeUndefined();
    expect(createDraftStore({ ...alice, keyId: 'k2' }, storage).read(replySlot('t1'))).toBeUndefined();
  });

  it('removes the entry of a blank compose field and of an edit field back at its server value', () => {
    const storage = createMemoryDraftStorage();
    const store = createDraftStore(alice, storage);
    const prompt = promptSlot({ id: 't1', title: 'T', input: 'I' });
    store.write(replySlot('t1'), 'typed');
    store.write(prompt, { title: 'T', input: 'edited' });
    expect(storage.entries.size).toBe(2);
    store.write(replySlot('t1'), '  \n');
    store.write(prompt, { title: 'T', input: 'I' });
    expect(storage.entries.size).toBe(0);
  });

  it('drops an edit draft whose server text changed, also in a new store over the same storage', () => {
    const storage = createMemoryDraftStorage();
    createDraftStore(alice, storage).write(promptSlot({ id: 't1', title: 'T', input: 'v1' }), {
      title: 'T',
      input: 'mine',
    });
    const reloaded = createDraftStore(alice, storage);
    expect(reloaded.read(promptSlot({ id: 't1', title: 'T', input: 'v1' }))).toEqual({ title: 'T', input: 'mine' });
    expect(reloaded.read(promptSlot({ id: 't1', title: 'T', input: 'v2' }))).toBeUndefined();
    expect(storage.entries.size).toBe(0);
  });

  it('restores an answer only for the same questions, and stores their hash instead of them', () => {
    const storage = createMemoryDraftStorage();
    const store = createDraftStore(alice, storage);
    const answer = { picks: [{ selected: ['No'], other: '' }], note: 'n' };
    store.write(answerSlot('t1', 'n1', 0, questions), answer);
    expect([...storage.entries.values()][0]).not.toContain('Add one?');
    expect(store.read(answerSlot('t1', 'n1', 0, questions))).toEqual(answer);
    store.write(answerSlot('t1', 'n1', 0, questions), answer);
    expect(store.read(answerSlot('t1', 'n1', 0, [{ ...questions[0]!, question: 'Other?' }]))).toBeUndefined();
    expect(storage.entries.size).toBe(0);
  });

  it.each([
    ['malformed JSON', '{nope'],
    ['a non-object', '"text"'],
    ['a non-string base', JSON.stringify({ value: 'x', base: 3 })],
    ['a value the slot rejects', JSON.stringify({ value: 42 })],
  ])('returns nothing and removes the entry for %s', (_name, stored) => {
    const key = `${DRAFT_PREFIX}alice/k1/reply:t1`;
    const storage = createMemoryDraftStorage({ [key]: stored });
    expect(createDraftStore(alice, storage).read(replySlot('t1'))).toBeUndefined();
    expect(storage.entries.size).toBe(0);
  });

  it('does not throw when the storage does, and reads nothing', () => {
    const boom = () => {
      throw new Error('blocked');
    };
    const throwing: DraftStorage = { getItem: boom, setItem: boom, removeItem: boom, key: boom, length: 1 };
    const store = createDraftStore(alice, throwing);
    expect(store.read(replySlot('t1'))).toBeUndefined();
    expect(() => {
      store.write(replySlot('t1'), 'x');
      store.clear('reply:t1');
      store.clearIfSent('reply:t1', 'x');
      removeDrafts({ storage: throwing });
    }).not.toThrow();
  });

  it('does not throw when reading the storage property itself throws', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage')!;
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
    try {
      const store = createDraftStore(alice);
      expect(store.read(replySlot('t1'))).toBeUndefined();
      expect(() => {
        store.write(replySlot('t1'), 'x');
        store.clear('reply:t1');
        removeDrafts();
      }).not.toThrow();
    } finally {
      Object.defineProperty(window, 'sessionStorage', original);
    }
  });

  it('clears a key, and clears a sent one only while the text is still what was sent', () => {
    const storage = createMemoryDraftStorage();
    const store = createDraftStore(alice, storage);
    store.write(replySlot('t1'), 'sent text');
    store.write(replySlot('t1'), 'sent text and more');
    store.clearIfSent('reply:t1', 'sent text');
    expect(store.read(replySlot('t1'))).toBe('sent text and more');
    store.clearIfSent('reply:t1', 'sent text and more');
    expect(storage.entries.size).toBe(0);
    store.write(forkSlot({ id: 'p', title: 'T' }), { title: 'x', input: 'y' });
    store.clear('fork:p');
    expect(storage.entries.size).toBe(0);
  });
});

describe('removeDrafts', () => {
  const seed = () =>
    createMemoryDraftStorage({
      [`${DRAFT_PREFIX}alice/k1/reply:t1`]: '{"value":"a"}',
      [`${DRAFT_PREFIX}alice/k2/reply:t1`]: '{"value":"b"}',
      [`${DRAFT_PREFIX}bob/k1/reply:t1`]: '{"value":"c"}',
      'agent-board.return': '/t/1',
    });

  it('removes every draft and leaves other keys alone', () => {
    const storage = seed();
    removeDrafts({ storage });
    expect([...storage.entries.keys()]).toEqual(['agent-board.return']);
  });

  it('keeps only the given identity’s drafts', () => {
    const storage = seed();
    removeDrafts({ keep: alice, storage });
    expect([...storage.entries.keys()]).toEqual([`${DRAFT_PREFIX}alice/k1/reply:t1`, 'agent-board.return']);
  });
});
