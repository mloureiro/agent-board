import { KeyError } from './kdf.mts';

// 32 random bytes, written in Crockford's base32 (no I, L, O or U, so nothing is confused with a digit) with four more
// characters of checksum, in groups of four: 56 characters in all.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const KEY_BYTES = 32;
const KEY_CHARS = 52;
const CHECK_CHARS = 4;
const GROUP = 4;
const CHECK_DOMAIN = new TextEncoder().encode('agent-board/v1/recovery-key-check');

function encode(bytes: Uint8Array, chars: number): string {
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out.slice(0, chars);
}

async function checksum(key: Uint8Array): Promise<string> {
  const input = new Uint8Array(CHECK_DOMAIN.length + key.length);
  input.set(CHECK_DOMAIN);
  input.set(key, CHECK_DOMAIN.length);
  return encode(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input)).subarray(0, 3), CHECK_CHARS);
}

export async function formatRecoveryKey(key: Uint8Array): Promise<string> {
  if (key.length !== KEY_BYTES) throw new KeyError('A recovery key is 32 bytes');
  const text = encode(key, KEY_CHARS) + (await checksum(key));
  return (text.match(new RegExp(`.{1,${GROUP}}`, 'g')) ?? []).join('-');
}

export const recoveryGroups = (text: string): string[] => text.split('-');

/** Text as the alphabet reads it: any case, no dashes or spaces, O and I and L read as 0 and 1. */
function normalise(text: string): string {
  return text.toUpperCase().replace(/[\s-]/g, '').replaceAll('O', '0').replace(/[IL]/g, '1');
}

/** Whether what someone typed is the same recovery text, or a group of it, as `expected`. */
export const sameRecoveryText = (typed: string, expected: string): boolean =>
  normalise(typed) !== '' && normalise(typed) === normalise(expected);

export async function parseRecoveryKey(text: string): Promise<Uint8Array> {
  const clean = normalise(text);
  const invalid = new KeyError('That is not a valid recovery key. Check it for typos.');
  if (clean.length !== KEY_CHARS + CHECK_CHARS || [...clean].some((char) => !ALPHABET.includes(char))) throw invalid;
  let bits = 0;
  let acc = 0;
  const bytes: number[] = [];
  for (const char of clean.slice(0, KEY_CHARS)) {
    acc = (acc << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((acc >> (bits - 8)) & 255);
      bits -= 8;
      acc &= (1 << bits) - 1;
    }
  }
  // 52 characters carry 260 bits; the four beyond the key's 256 are zero.
  if (acc !== 0) throw invalid;
  const key = Uint8Array.from(bytes);
  if ((await checksum(key)) !== clean.slice(KEY_CHARS)) throw invalid;
  return key;
}
