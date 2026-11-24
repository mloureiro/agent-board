import { createUnlocker, type Argon2id } from '@agent-board/shared/ui';
import { argon2id } from 'hash-wasm';

export const argon2idHash: Argon2id = (options) => argon2id({ ...options, outputType: 'binary' });

export const { openDataKey, createKeySetup, unlockKeys, replacePassphrase, exportDataKey } =
  createUnlocker(argon2idHash);
