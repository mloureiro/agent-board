import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, describe, it } from 'node:test';
import { deriveKeys, fromBase64Url, open, type Keys } from '../crypto.mts';
import type { KeySetup } from '../keys.mts';
import { testArgon2id } from './argon2idForTests.mts';
import {
  FIXTURES,
  openers,
  redact,
  sealers,
  valueAt,
  type KeyFixture,
  type RequestCase,
  type ResponseCase,
} from './goldenCalls.mts';
import { derivePassphraseKey } from './kdf.mts';
import { createUnlocker } from './keySlots.mts';

const load = <T,>(name: string): T => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as T;

const fixture = load<KeyFixture>('keys.json');
const requests = load<{ cases: RequestCase[] }>('requests.json').cases;
const responses = load<{ cases: ResponseCase[] }>('responses.json').cases;

const bytes = (text: string): Uint8Array => {
  const decoded = fromBase64Url(text);
  if (decoded === null) throw new Error('the fixture holds a value that is not base64url');
  return decoded;
};

const { openDataKey, unlockKeys } = createUnlocker(testArgon2id);

let keys: Keys;

before(async () => {
  keys = await deriveKeys(bytes(fixture.dataKey), fixture.owner);
});

// A client chooses the id of a new task or schedule at random, so a sealed-again request carries another id than the recorded
// one; the recorded bindings and clear fields are compared with that id in its place.
function withId(record: RequestCase, sealed: unknown): RequestCase {
  const [recorded, ...more] = record.ids;
  if (recorded === undefined) return record;
  assert.equal(more.length, 0, 'a case draws at most one id');
  const { id } = sealed as { id: string };
  const swap = <T,>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll(recorded, id)) as T;
  return { ...record, fields: swap(record.fields), clear: swap(record.clear) };
}

async function assertOpensToRecord(sealed: unknown, record: RequestCase): Promise<void> {
  for (const { at, field, context, plaintext } of record.fields) {
    const envelope = valueAt(sealed, at) as string;
    assert.equal(await open(keys, field as Parameters<typeof open>[1], context, envelope), plaintext, at);
  }
  assert.deepEqual(
    redact(
      sealed,
      record.fields.map((field) => field.at),
    ),
    record.clear,
  );
}

describe('the keys recorded from the browser', () => {
  it('derive the recorded key id from the recorded data key', () => {
    assert.equal(keys.keyId, fixture.keyId);
  });

  it('derive the recorded wrapping key from the recorded passphrase and salt', async () => {
    const wrappingKey = await derivePassphraseKey(fixture.passphrase, bytes(fixture.salt), fixture.kdf, testArgon2id);
    assert.deepEqual(Array.from(wrappingKey), Array.from(bytes(fixture.wrappingKey)));
  });

  it('open the recorded key setup with the passphrase and with the recovery key to one data key and its key id', async () => {
    const { passphrase, recoveryKey, keyId } = fixture.setup;
    const keySetup = fixture.setup.keySetup as KeySetup;
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

describe('the sealed requests', () => {
  it('cover every request sealer', () => {
    assert.deepEqual(new Set(requests.map((record) => record.sealer)), new Set(Object.keys(sealers)));
  });

  for (const record of requests)
    describe(record.name, () => {
      it('opens as recorded, with its clear fields as recorded', async () => {
        await assertOpensToRecord(record.sealed, record);
      });

      it('is sealed again from the recorded input to a request that opens as recorded', async () => {
        const sealed: unknown = JSON.parse(JSON.stringify(await sealers[record.sealer]?.(keys, record.args)));
        await assertOpensToRecord(sealed, withId(record, sealed));
      });
    });
});

describe('the opened responses', () => {
  it('cover every opener', () => {
    assert.deepEqual(new Set(responses.map((record) => record.opener)), new Set(Object.keys(openers)));
  });

  for (const record of responses)
    it(`are as recorded for ${record.name}`, async () => {
      const opened: unknown = JSON.parse(JSON.stringify(await openers[record.opener]?.(keys, record.args)));
      assert.deepEqual(opened, record.opened);
    });
});
