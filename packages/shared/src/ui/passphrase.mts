export const MIN_PASSPHRASE_LENGTH = 14;

export const PASSPHRASE_ADVICE =
  'Whoever runs the server holds a copy of your key that is protected only by this passphrase, and can guess at it offline. ' +
  'Length is what stops that: several unrelated words in a row are stronger than a short password with symbols.';

/**
 * The passphrase as it is checked and hashed, in this one place: setup, unlock and a change all reach the key derivation through
 * it. Surrounding whitespace is dropped (a space typed by accident, or one a password manager adds) and the rest is NFKC, so
 * one passphrase types the same everywhere. The length floor counts what is hashed.
 */
export function normalizePassphrase(passphrase: string): string {
  return passphrase.trim().normalize('NFKC');
}

/** Whether two typed passphrases are the same passphrase. */
export const samePassphrase = (left: string, right: string): boolean =>
  normalizePassphrase(left) === normalizePassphrase(right);

/** Why a passphrase is too weak, or null: a length floor and no composition rules. */
export function passphraseProblem(passphrase: string): string | null {
  return Array.from(normalizePassphrase(passphrase)).length < MIN_PASSPHRASE_LENGTH
    ? `Use at least ${MIN_PASSPHRASE_LENGTH} characters.`
    : null;
}
