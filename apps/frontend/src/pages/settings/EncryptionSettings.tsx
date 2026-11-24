import { Button, Code, Group, Paper, PasswordInput, Stack, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { KeyError, PASSPHRASE_ADVICE } from '@agent-board/shared/ui';
import { replacePassphrase } from '../../crypto/unlocker';
import { useKeys } from '../../crypto/KeyContext';
import { NewPassphraseFields, useNewPassphrase } from '../../crypto/NewPassphraseFields';
import { useSubmit } from '../../crypto/useSubmit';
import { useTRPC } from '../../lib/trpc';
import { asHeld } from './asHeld';

export function EncryptionSettings() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const keys = useKeys();
  const replaceSlots = useMutation(trpc.keys.replaceSlots.mutationOptions());
  const [current, setCurrent] = useState('');
  const next = useNewPassphrase();
  const ready = current !== '' && next.valid;
  const { busy, error, submit } = useSubmit(async () => {
    const stored = await queryClient.fetchQuery(trpc.keys.get.queryOptions());
    if (!keys || !stored) throw new KeyError('The key is not available. Reload the page.');
    const { slots } = await replacePassphrase({
      owner: keys.owner,
      stored: asHeld(stored, keys),
      secret: { kind: 'passphrase', passphrase: current },
      newPassphrase: next.passphrase,
    });
    await replaceSlots.mutateAsync({ keyId: keys.keyId, slots });
    setCurrent('');
    next.reset();
    notifications.show({ color: 'teal', message: 'Passphrase changed. The recovery key still works.' });
  }, ready);

  return (
    <Paper withBorder p="md">
      <Stack>
        <div>
          <Title order={5}>Encryption</Title>
          <Text size="sm" c="dimmed">
            Your board is encrypted with a key only you hold
            {keys ? (
              <>
                {' '}
                (key id <Code>{keys.keyId}</Code>)
              </>
            ) : null}
            . {PASSPHRASE_ADVICE}
          </Text>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Stack maw={360}>
            <PasswordInput
              label="Current passphrase"
              value={current}
              onChange={(event) => setCurrent(event.currentTarget.value)}
              error={error}
              autoComplete="current-password"
            />
            <NewPassphraseFields state={next} />
            <Group>
              <Button type="submit" disabled={!ready} loading={busy}>
                Change passphrase
              </Button>
            </Group>
          </Stack>
        </form>
      </Stack>
    </Paper>
  );
}
