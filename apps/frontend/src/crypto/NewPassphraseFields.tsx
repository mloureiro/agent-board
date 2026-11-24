import { PasswordInput } from '@mantine/core';
import { useState } from 'react';
import { passphraseProblem, samePassphrase } from '@agent-board/shared/ui';
export interface NewPassphrase {
  passphrase: string;
  again: string;
  setPassphrase: (value: string) => void;
  setAgain: (value: string) => void;
  /** Long enough and typed the same twice. */
  valid: boolean;
  reset: () => void;
}

/** A new passphrase typed twice; render it with NewPassphraseFields. */
export function useNewPassphrase(): NewPassphrase {
  const [passphrase, setPassphrase] = useState('');
  const [again, setAgain] = useState('');
  return {
    passphrase,
    again,
    setPassphrase,
    setAgain,
    valid: passphrase !== '' && passphraseProblem(passphrase) === null && samePassphrase(again, passphrase),
    reset: () => {
      setPassphrase('');
      setAgain('');
    },
  };
}

export function NewPassphraseFields({
  state,
  label = 'New passphrase',
  autoFocus = false,
}: {
  state: NewPassphrase;
  label?: string;
  autoFocus?: boolean;
}) {
  const { passphrase, again, setPassphrase, setAgain } = state;
  return (
    <>
      <PasswordInput
        label={label}
        value={passphrase}
        onChange={(event) => setPassphrase(event.currentTarget.value)}
        error={passphrase === '' ? null : passphraseProblem(passphrase)}
        autoComplete="new-password"
        data-autofocus={autoFocus || undefined}
      />
      <PasswordInput
        label={`${label} again`}
        value={again}
        onChange={(event) => setAgain(event.currentTarget.value)}
        error={again !== '' && !samePassphrase(again, passphrase) ? 'The passphrases differ.' : null}
        autoComplete="new-password"
      />
    </>
  );
}
