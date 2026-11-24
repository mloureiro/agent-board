import { useState } from 'react';
import { errorMessage } from '../lib/trpc';
import { KeyError } from '@agent-board/shared/ui';
/**
 * A KeyError keeps its own message: errorMessage's `instanceof Error` misses it where the Error global is another realm's,
 * as under jsdom.
 */
const messageOf = (error: unknown): string => (error instanceof KeyError ? error.message : errorMessage(error));

/**
 * A form submit that shows it is busy and keeps the failure's message for the form to show. A second submit while one runs,
 * or one the form is not ready for, does nothing.
 */
export function useSubmit(run: () => Promise<void>, ready: boolean) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}
