import type { Keys } from '@agent-board/shared';
import { Alert, Anchor, Button, PasswordInput, Stack, Text, TextInput } from '@mantine/core';
import { useState } from 'react';
import { ExportFileChooser, type ChosenExport } from '../components/ExportFileChooser';
import { ExportFileSummary } from '../components/ExportFileSummary';
import { ImportRunView } from '../components/ImportRunView';
import { useImportRun } from '../components/useImportRun';
import { useRawTRPCClient } from '../lib/trpc';
import { type Secret } from '@agent-board/shared/ui';
import { unlockKeys } from './unlocker';
import { useSubmit } from './useSubmit';

interface Props {
  owner: string;
  /** Called with the file's keys once the person has seen how the import went. */
  onComplete: (keys: Keys) => Promise<void>;
  onBack: () => void;
  /** True from before the key is stored until `onComplete`: the screen must stay while the import runs. */
  onImporting: (importing: boolean) => void;
}

/**
 * Sets this account up with the key of an export, then imports the export. The file's key slots are opened with its own
 * passphrase or recovery key, and nothing is written until they open and match the key id in the file.
 */
export function ImportSetup({ owner, onComplete, onBack, onImporting }: Props) {
  const client = useRawTRPCClient();
  const runner = useImportRun();
  const [chosen, setChosen] = useState<ChosenExport | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [secretText, setSecretText] = useState('');
  const [keys, setKeys] = useState<Keys | null>(null);

  const { busy, error, submit } = useSubmit(
    async () => {
      if (chosen === null) return;
      const { header, file } = chosen;
      const stored = { keyId: header.keyId, slots: header.keySlots };
      const secret: Secret = recovering
        ? { kind: 'recovery', recoveryKey: secretText }
        : { kind: 'passphrase', passphrase: secretText };
      const opened = await unlockKeys({ owner, stored, secret });
      onImporting(true);
      try {
        await client.keys.setup.mutate(stored);
      } catch (err) {
        onImporting(false);
        throw err;
      }
      setKeys(opened);
      await runner.start(file, opened);
    },
    chosen !== null && secretText.trim() !== '',
  );

  if (keys !== null && chosen !== null) {
    const { run } = runner;
    const finished = run.status === 'done' || run.status === 'failed' || run.status === 'cancelled';
    return (
      <Stack>
        <Text size="sm">Your key is set up. The rows of the file are being added to the board.</Text>
        <ImportRunView run={run} onCancel={runner.cancel} owner={owner} fileOwner={chosen.header.owner} />
        {(run.status === 'failed' || run.status === 'cancelled') && (
          <Alert color="orange" title="The import is not complete">
            <Text size="sm">
              The key stays set up. Open Settings after you continue and import the file again: rows that are already
              there are skipped.
            </Text>
          </Alert>
        )}
        {finished && <Button onClick={() => void onComplete(keys)}>Continue to the board</Button>}
      </Stack>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Stack>
        <Text size="sm">
          Choose a file you exported from this board or another one, and enter the passphrase or recovery key it was
          exported with. This account takes over that key.
        </Text>
        <ExportFileChooser disabled={busy} onChange={setChosen} />
        {chosen !== null && (
          <>
            <ExportFileSummary header={chosen.header} owner={owner} />
            {recovering ? (
              <TextInput
                label="Recovery key of the export"
                value={secretText}
                onChange={(event) => setSecretText(event.currentTarget.value)}
                error={error}
                autoComplete="off"
                spellCheck={false}
                styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
              />
            ) : (
              <PasswordInput
                label="Passphrase of the export"
                value={secretText}
                onChange={(event) => setSecretText(event.currentTarget.value)}
                error={error}
                autoComplete="current-password"
              />
            )}
            <Anchor
              component="button"
              type="button"
              size="sm"
              onClick={() => {
                setRecovering(!recovering);
                setSecretText('');
              }}
            >
              {recovering ? 'Use the passphrase' : 'Use the recovery key'}
            </Anchor>
            <Button type="submit" disabled={secretText.trim() === ''} loading={busy}>
              Set up with this key and import
            </Button>
          </>
        )}
        <Anchor component="button" type="button" size="sm" onClick={onBack} disabled={busy}>
          Set up a new key instead
        </Anchor>
      </Stack>
    </form>
  );
}
