export const ENVELOPE_PREFIX = 'abe1.';

const BLIND_PREFIX = 'abh1.';
const DATA_KEY_PREFIX = 'abk1_';
const WRAPPED_PREFIX = 'abw1.';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MIN_ENVELOPE_BYTES = NONCE_BYTES + TAG_BYTES;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

// Fixed HKDF salt. It only domain-separates this protocol; the data key supplies the entropy.
const HKDF_SALT = utf8('agent-board/v1/salt');
const WRAP_AAD = utf8('v1\0wrap-data-key');

export type Field =
  | 'title'
  | 'input'
  | 'workdir'
  | 'agent'
  | 'icon'
  | 'pr'
  | 'watches'
  | 'machine.dirs'
  | 'machine.catalog'
  | 'machine.usage'
  | 'machine.feeds'
  | 'agents.shared'
  | 'links'
  | 'note.body'
  | 'note.preview'
  | 'note.suggestion'
  | 'note.questions'
  | 'note.answers'
  | 'tr.data'
  | 'tr.output';

export interface Keys {
  owner: string;
  keyId: string;
  enc: CryptoKey;
  transcript: CryptoKey;
  index?: CryptoKey;
}

type CryptoKey = Awaited<ReturnType<typeof globalThis.crypto.subtle.importKey>>;

export class CryptoError extends Error {}

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** Decodes unpadded base64url; null for anything but the one canonical encoding of some byte string. */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL.test(text) || text.length % 4 === 1) return null;
  const padded = text
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(text.length / 4) * 4, '=');
  const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  // Reject non-canonical trailing bits so that one byte string has exactly one encoding.
  return toBase64Url(bytes) === text ? bytes : null;
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

function assertKeyBytes(key: Uint8Array, what: string): Uint8Array<ArrayBuffer> {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES)
    throw new CryptoError(`${what} must be ${KEY_BYTES} bytes`);
  return Uint8Array.from(key);
}

function assertNoNul(value: string, what: string): void {
  if (value.includes('\0')) throw new CryptoError(`${what} must not contain a NUL character`);
}

function additionalData(owner: string, field: string, context: string): Uint8Array<ArrayBuffer> {
  assertNoNul(owner, 'owner');
  assertNoNul(field, 'field');
  assertNoNul(context, 'context');
  return utf8(`v1\0${owner}\0${field}\0${context}`);
}

async function encrypt(key: CryptoKey, additional: Uint8Array<ArrayBuffer>, plaintext: Uint8Array<ArrayBuffer>) {
  const nonce = randomBytes(NONCE_BYTES);
  const sealed = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: additional, tagLength: TAG_BYTES * 8 },
    key,
    plaintext,
  );
  const out = new Uint8Array(NONCE_BYTES + sealed.byteLength);
  out.set(nonce);
  out.set(new Uint8Array(sealed), NONCE_BYTES);
  return toBase64Url(out);
}

async function decrypt(
  key: CryptoKey,
  additional: Uint8Array<ArrayBuffer>,
  body: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = fromBase64Url(body);
  if (bytes === null || bytes.length < MIN_ENVELOPE_BYTES) throw new CryptoError('not a valid envelope');
  try {
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.subarray(0, NONCE_BYTES), additionalData: additional, tagLength: TAG_BYTES * 8 },
      key,
      bytes.subarray(NONCE_BYTES),
    );
    return new Uint8Array(plain);
  } catch {
    throw new CryptoError('decryption failed: wrong key, wrong owner, field or context, or damaged data');
  }
}

/** The length of the envelope that `seal` makes of `plainBytes` bytes of UTF-8: the prefix, then base64url of nonce, data and tag. */
export function envelopeLength(plainBytes: number): number {
  return ENVELOPE_PREFIX.length + Math.ceil(((plainBytes + MIN_ENVELOPE_BYTES) * 4) / 3);
}

export function isEnvelope(value: string): boolean {
  if (!value.startsWith(ENVELOPE_PREFIX)) return false;
  const body = value.slice(ENVELOPE_PREFIX.length);
  return BASE64URL.test(body) && body.length >= Math.ceil((MIN_ENVELOPE_BYTES * 4) / 3);
}

export function generateDataKey(): Uint8Array {
  return randomBytes(KEY_BYTES);
}

export async function deriveKeys(dataKey: Uint8Array, owner: string, options: { index?: boolean } = {}): Promise<Keys> {
  assertNoNul(owner, 'owner');
  const { subtle } = globalThis.crypto;
  const master = await subtle.importKey('raw', assertKeyBytes(dataKey, 'data key'), 'HKDF', false, [
    'deriveBits',
    'deriveKey',
  ]);
  const hkdf = (purpose: string) => ({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: HKDF_SALT,
    info: utf8(`agent-board/v1/${purpose}`),
  });
  const aes = (purpose: string): Promise<CryptoKey> =>
    subtle.deriveKey(hkdf(purpose), master, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

  const [enc, transcript, idBits, index] = await Promise.all([
    aes('enc'),
    aes('transcript'),
    subtle.deriveBits(hkdf('id'), master, 256),
    options.index
      ? subtle.deriveKey(hkdf('index'), master, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'])
      : undefined,
  ]);
  const keyId = Array.from(new Uint8Array(idBits).subarray(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
  return { owner, keyId, enc, transcript, ...(index ? { index } : {}) };
}

export async function seal(keys: Keys, field: Field, context: string, plaintext: string): Promise<string> {
  const key = field.startsWith('tr.') ? keys.transcript : keys.enc;
  const body = await encrypt(key, additionalData(keys.owner, field, context), utf8(plaintext));
  return ENVELOPE_PREFIX + body;
}

export async function open(keys: Keys, field: Field, context: string, envelope: string): Promise<string> {
  if (!isEnvelope(envelope)) throw new CryptoError('not an envelope');
  const key = field.startsWith('tr.') ? keys.transcript : keys.enc;
  const plain = await decrypt(key, additionalData(keys.owner, field, context), envelope.slice(ENVELOPE_PREFIX.length));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(plain);
  } catch {
    throw new CryptoError('decrypted data is not valid UTF-8');
  }
}

export async function blindIndex(keys: Keys, value: string): Promise<string> {
  if (!keys.index) throw new CryptoError('the index key was not derived; pass { index: true } to deriveKeys');
  const mac = await globalThis.crypto.subtle.sign('HMAC', keys.index, utf8(value));
  return BLIND_PREFIX + toBase64Url(new Uint8Array(mac));
}

/** Structural check for `blindIndex`'s output: the prefix, then base64url of a 32-byte HMAC. */
export function isBlindIndex(value: string): boolean {
  if (!value.startsWith(BLIND_PREFIX)) return false;
  const body = value.slice(BLIND_PREFIX.length);
  return BASE64URL.test(body) && body.length === Math.ceil((KEY_BYTES * 4) / 3);
}

export function encodeDataKey(key: Uint8Array): string {
  return DATA_KEY_PREFIX + toBase64Url(assertKeyBytes(key, 'data key'));
}

export function decodeDataKey(text: string): Uint8Array {
  if (!text.startsWith(DATA_KEY_PREFIX)) throw new CryptoError(`a data key starts with "${DATA_KEY_PREFIX}"`);
  const bytes = fromBase64Url(text.slice(DATA_KEY_PREFIX.length));
  if (bytes === null || bytes.length !== KEY_BYTES) throw new CryptoError('the data key is malformed');
  return bytes;
}

async function importWrappingKey(wrappingKey: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey('raw', assertKeyBytes(wrappingKey, 'wrapping key'), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function wrapDataKey(wrappingKey: Uint8Array, dataKey: Uint8Array): Promise<string> {
  const plaintext = assertKeyBytes(dataKey, 'data key');
  return WRAPPED_PREFIX + (await encrypt(await importWrappingKey(wrappingKey), WRAP_AAD, plaintext));
}

export async function unwrapDataKey(wrappingKey: Uint8Array, wrapped: string): Promise<Uint8Array> {
  const key = await importWrappingKey(wrappingKey);
  if (!wrapped.startsWith(WRAPPED_PREFIX)) throw new CryptoError('not a wrapped data key');
  const plain = await decrypt(key, WRAP_AAD, wrapped.slice(WRAPPED_PREFIX.length));
  if (plain.length !== KEY_BYTES) throw new CryptoError('the wrapped data key has the wrong length');
  return plain;
}

/** Structural check for `wrapDataKey`'s output: the prefix, the base64url alphabet and the exact length of a wrapped 32-byte key. */
export function isWrappedKey(value: string): boolean {
  if (!value.startsWith(WRAPPED_PREFIX)) return false;
  const body = value.slice(WRAPPED_PREFIX.length);
  return BASE64URL.test(body) && body.length === Math.ceil(((NONCE_BYTES + KEY_BYTES + TAG_BYTES) * 4) / 3);
}
