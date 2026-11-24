import { KDF_LIMITS } from '../keys.mts';
import { normalizePassphrase } from './passphrase.mts';

/** Argon2id cost: memory in KiB, passes, lanes. */
export interface KdfParams {
  m: number;
  t: number;
  p: number;
}

/** The Argon2id hash each UI supplies: shared holds no implementation of it. */
export type Argon2id = (options: {
  password: string;
  salt: Uint8Array;
  parallelism: number;
  iterations: number;
  memorySize: number;
  hashLength: number;
}) => Promise<Uint8Array>;

export const PRODUCTION_KDF: KdfParams = { m: 65_536, t: 3, p: 1 };
export const SALT_BYTES = 16;
const KEY_BYTES = 32;

export class KeyError extends Error {}

/** A wrong passphrase or recovery key; the message never says which part was wrong. */
export class WrongSecretError extends KeyError {}

/** Refuses cost parameters from a stored slot that are outside what this client will compute. */
export function assertWithinLimits(params: KdfParams): void {
  const outside = (['m', 't', 'p'] as const).some((key) => {
    const { min, max } = KDF_LIMITS[key];
    return !Number.isInteger(params[key]) || params[key] < min || params[key] > max;
  });
  if (outside) throw new KeyError('This key asks for more computing than this browser accepts, so it was not tried.');
}

/** The 32-byte wrapping key for a passphrase, as `normalizePassphrase` makes it: the only way a passphrase reaches the hash. */
export async function derivePassphraseKey(
  passphrase: string,
  salt: Uint8Array,
  params: KdfParams,
  argon2id: Argon2id,
): Promise<Uint8Array> {
  assertWithinLimits(params);
  return argon2id({
    password: normalizePassphrase(passphrase),
    salt,
    parallelism: params.p,
    iterations: params.t,
    memorySize: params.m,
    hashLength: KEY_BYTES,
  });
}
