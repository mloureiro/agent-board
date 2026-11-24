import type { KeySetup, Keys } from '@agent-board/shared';
import {
  Anchor,
  Button,
  Center,
  Group,
  Loader,
  Paper,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { errorMessage, useTRPC } from '../lib/trpc';
import { PASSPHRASE_ADVICE, PRODUCTION_KDF, type KdfParams, type Secret } from '@agent-board/shared/ui';
import { replacePassphrase, unlockKeys } from './unlocker';
import { NewPassphraseFields, useNewPassphrase } from './NewPassphraseFields';
import { useSubmit } from './useSubmit';

interface Props {
  owner: string;
  onUnlocked: (keys: Keys) => Promise<void>;
  kdf?: KdfParams;
}

function PassphraseForm({
  owner,
  stored,
  onUnlocked,
}: {
  owner: string;
  stored: KeySetup;
  onUnlocked: Props['onUnlocked'];
}) {
  const [passphrase, setPassphrase] = useState('');
  const { busy, error, submit } = useSubmit(async () => {
    await onUnlocked(await unlockKeys({ owner, stored, secret: { kind: 'passphrase', passphrase } }));
  }, passphrase !== '');
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Stack>
        <PasswordInput
          label="Passphrase"
          value={passphrase}
          onChange={(event) => setPassphrase(event.currentTarget.value)}
          error={error}
          autoComplete="current-password"
          data-autofocus
        />
        <Button type="submit" disabled={passphrase === ''} loading={busy}>
          Unlock
        </Button>
      </Stack>
    </form>
  );
}

function RecoveryForm({
  owner,
  stored,
  kdf,
  onUnlocked,
}: {
  owner: string;
  stored: KeySetup;
  kdf: KdfParams;
  onUnlocked: Props['onUnlocked'];
}) {
  const trpc = useTRPC();
  const replaceSlots = useMutation(trpc.keys.replaceSlots.mutationOptions());
  const [recoveryKey, setRecoveryKey] = useState('');
  const passphrase = useNewPassphrase();
  const ready = recoveryKey.trim() !== '' && passphrase.valid;
  const { busy, error, submit } = useSubmit(async () => {
    const secret: Secret = { kind: 'recovery', recoveryKey };
    const newPassphrase = passphrase.passphrase;
    const { keys, slots } = await replacePassphrase({ owner, stored, secret, newPassphrase, kdf });
    await replaceSlots.mutateAsync({ keyId: stored.keyId, slots });
    await onUnlocked(keys);
  }, ready);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Stack>
        <Text size="sm">
          Enter your recovery key and choose a new passphrase. The recovery key stays valid, so keep it.
        </Text>
        <TextInput
          label="Recovery key"
          value={recoveryKey}
          onChange={(event) => setRecoveryKey(event.currentTarget.value)}
          autoComplete="off"
          spellCheck={false}
          styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
          data-autofocus
        />
        <Text size="sm" c="dimmed">
          {PASSPHRASE_ADVICE}
        </Text>
        <NewPassphraseFields state={passphrase} />
        {error && (
          <Text c="red" size="sm">
            {error}
          </Text>
        )}
        <Button type="submit" disabled={!ready} loading={busy}>
          Unlock with the recovery key
        </Button>
      </Stack>
    </form>
  );
}

/** The board has a key but this browser has none usable: the passphrase opens it, or the recovery key and a new passphrase. */
export function UnlockScreen({ owner, onUnlocked, kdf = PRODUCTION_KDF }: Props) {
  const trpc = useTRPC();
  const stored = useQuery(trpc.keys.get.queryOptions());
  const [recovering, setRecovering] = useState(false);
  return (
    <Center mih="100vh" p="md">
      <Paper withBorder p="xl" maw={480} w="100%">
        <Stack>
          <Group gap="xs">
            <IconLock size={22} />
            <Title order={3}>Unlock the board</Title>
          </Group>
          {stored.isLoading && <Loader size="sm" />}
          {stored.error && <Text c="red">{errorMessage(stored.error)}</Text>}
          {stored.data === null && <Text c="red">No key is set up for this account.</Text>}
          {stored.data &&
            (recovering ? (
              <RecoveryForm owner={owner} stored={stored.data} kdf={kdf} onUnlocked={onUnlocked} />
            ) : (
              <PassphraseForm owner={owner} stored={stored.data} onUnlocked={onUnlocked} />
            ))}
          {stored.data && (
            <Anchor component="button" type="button" size="sm" onClick={() => setRecovering(!recovering)}>
              {recovering ? 'Use my passphrase' : 'Use my recovery key'}
            </Anchor>
          )}
        </Stack>
      </Paper>
    </Center>
  );
}
