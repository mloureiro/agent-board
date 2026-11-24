import { argon2id } from 'hash-wasm';
import type { Argon2id } from './kdf.mts';

export const testArgon2id: Argon2id = (options) => argon2id({ ...options, outputType: 'binary' });
