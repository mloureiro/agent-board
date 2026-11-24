// @vitest-environment node
import { deriveKeys, fromBase64Url, open, type Keys } from '@agent-board/shared';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  FIXTURES,
  openers,
  redact,
  sealers,
  valueAt,
  type KeyFixture,
  type RequestCase,
  type ResponseCase,
} from './goldenCalls';

const ids = vi.hoisted(() => ({ queue: [] as string[] }));

vi.mock('@agent-board/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-board/shared')>()),
  newTaskId: () => ids.queue.shift() ?? 'unset',
}));

const load = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as T;

const keyFixture = load<KeyFixture>('keys.json');
const requests = load<{ cases: RequestCase[] }>('requests.json').cases;
const responses = load<{ cases: ResponseCase[] }>('responses.json').cases;

const bytes = (text: string): Uint8Array => {
  const decoded = fromBase64Url(text);
  if (decoded === null) throw new Error('the fixture holds a value that is not base64url');
  return decoded;
};

let keys: Keys;

beforeAll(async () => {
  keys = await deriveKeys(bytes(keyFixture.dataKey), keyFixture.owner);
});

async function expectOpensToRecord(sealed: unknown, record: RequestCase): Promise<void> {
  for (const { at, field, context, plaintext } of record.fields) {
    const envelope = valueAt(sealed, at) as string;
    expect(await open(keys, field as Parameters<typeof open>[1], context, envelope), at).toBe(plaintext);
  }
  expect(
    redact(
      sealed,
      record.fields.map((field) => field.at),
    ),
  ).toEqual(record.clear);
}

describe('the keys', () => {
  it('derive the recorded key id from the recorded data key', () => {
    expect(keys.keyId).toBe(keyFixture.keyId);
  });
});

describe('the sealed requests', () => {
  it('cover every request sealer', () => {
    expect(new Set(requests.map((record) => record.sealer))).toEqual(new Set(Object.keys(sealers)));
  });

  describe.each(requests)('$name', (record) => {
    it('opens as recorded, with its clear fields as recorded', async () => {
      await expectOpensToRecord(record.sealed, record);
    });

    it('is sealed again from the recorded input to a request that opens as recorded', async () => {
      ids.queue = [...record.ids];
      const sealed: unknown = JSON.parse(JSON.stringify(await sealers[record.sealer]?.(keys, record.args)));
      await expectOpensToRecord(sealed, record);
    });
  });
});

describe('the opened responses', () => {
  it('cover every opener', () => {
    expect(new Set(responses.map((record) => record.opener))).toEqual(new Set(Object.keys(openers)));
  });

  it.each(responses)('are as recorded for $name', async (record) => {
    const opened: unknown = JSON.parse(JSON.stringify(await openers[record.opener]?.(keys, record.args)));
    expect(opened).toEqual(record.opened);
  });
});
