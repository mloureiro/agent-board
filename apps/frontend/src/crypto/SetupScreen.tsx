import type { KeySetup, Keys } from '@agent-board/shared';
import {
  Alert,
  Anchor,
  Button,
  Center,
  Checkbox,
  Code,
  CopyButton,
  Group,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconCopy, IconLock } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTRPC } from '../lib/trpc';
import {
  PASSPHRASE_ADVICE,
  PRODUCTION_KDF,
  recoveryGroups,
  sameRecoveryText,
  type KdfParams,
} from '@agent-board/shared/ui';
import { createKeySetup } from './unlocker';
import { ImportSetup } from './ImportSetup';
import { NewPassphraseFields, useNewPassphrase } from './NewPassphraseFields';
import { useSubmit } from './useSubmit';

// Which groups of the recovery key the person types back (1-based), to show they have a copy they can read.
const CONFIRM_GROUPS = [3, 11] as const;

interface Ready {
  setup: KeySetup;
  keys: Keys;
  recoveryKey: string;
}

interface Props {
  owner: string;
  onComplete: (keys: Keys) => Promise<void>;
  /** Told when an import of an export is under way, so the host keeps this screen until `onComplete`. */
  onImporting?: (importing: boolean) => void;
  kdf?: KdfParams;
}

function PassphraseStep({ owner, kdf, onReady }: { owner: string; kdf: KdfParams; onReady: (ready: Ready) => void }) {
  const passphrase = useNewPassphrase();
  const [firstTime, setFirstTime] = useState(false);
  const ready = firstTime && passphrase.valid;
  const { busy, error, submit } = useSubmit(async () => {
    onReady(await createKeySetup({ owner, passphrase: passphrase.passphrase, kdf }));
  }, ready);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Stack>
        <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Only if this board has never been used">
          <Text size="sm">
            If this board was already in use, do not set up again. A new key is a different key: your worker machines do
            not hold it, and it cannot read anything stored under the old one. A board that reports no key may be a new
            one, or a browser that does not hold your key (after Lock, in a private window, on another computer) while
            the board does, and then you need your passphrase or recovery key instead. Ask whoever runs the board if you
            are unsure.
          </Text>
        </Alert>
        <Text size="sm">
          Everything on this board (titles, prompts, notes, transcripts) is encrypted in your browser with a key of your
          own before it is sent, so the server only stores text it cannot read. Choose a passphrase to protect that key.
        </Text>
        <Text size="sm" c="dimmed">
          {PASSPHRASE_ADVICE}
        </Text>
        <NewPassphraseFields state={passphrase} label="Passphrase" autoFocus />
        <Checkbox
          checked={firstTime}
          onChange={(event) => setFirstTime(event.currentTarget.checked)}
          label="This is the first time this board is set up. I understand that setting up again would create a second key that existing content and my worker machines cannot use."
        />
        {error && (
          <Text c="red" size="sm">
            {error}
          </Text>
        )}
        <Button type="submit" disabled={!ready} loading={busy}>
          Create my key
        </Button>
      </Stack>
    </form>
  );
}

function RecoveryStep({ ready, onComplete }: { ready: Ready; onComplete: (keys: Keys) => Promise<void> }) {
  const trpc = useTRPC();
  const setup = useMutation(trpc.keys.setup.mutationOptions());
  const groups = recoveryGroups(ready.recoveryKey);
  const [typed, setTyped] = useState<string[]>(CONFIRM_GROUPS.map(() => ''));
  const [saved, setSaved] = useState(false);
  const confirmed = CONFIRM_GROUPS.every((group, index) =>
    sameRecoveryText(typed[index] ?? '', groups[group - 1] ?? ''),
  );
  const finish = () =>
    setup.mutate(ready.setup, {
      onSuccess: () => onComplete(ready.keys),
    });
  return (
    <Stack>
      <Alert color="orange" icon={<IconAlertTriangle size={18} />} title="Your recovery key, shown once">
        <Text size="sm">
          If you forget your passphrase, this is the only way back in. Write it down or save it in a password manager
          now: it is not stored anywhere and cannot be shown again.{' '}
          <b>If you lose both the passphrase and the recovery key, your board cannot be read by anyone, ever.</b> There
          is no reset.
        </Text>
      </Alert>
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <Code block data-testid="recovery-key" style={{ flex: 1, fontSize: 16, lineHeight: 1.8, userSelect: 'all' }}>
          {ready.recoveryKey}
        </Code>
        <CopyButton value={ready.recoveryKey}>
          {({ copied, copy }) => (
            <Button
              variant="default"
              onClick={copy}
              leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          )}
        </CopyButton>
      </Group>
      <Text size="sm">
        To check you have it, type groups {CONFIRM_GROUPS.join(' and ')} from your copy (groups are separated by
        dashes).
      </Text>
      <Group grow>
        {CONFIRM_GROUPS.map((group, index) => (
          <TextInput
            key={group}
            label={`Group ${group}`}
            value={typed[index]}
            onChange={(event) => setTyped(typed.map((value, i) => (i === index ? event.currentTarget.value : value)))}
            autoComplete="off"
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
          />
        ))}
      </Group>
      <Checkbox
        checked={saved}
        onChange={(event) => setSaved(event.currentTarget.checked)}
        label="I have stored the recovery key somewhere safe."
      />
      <Button onClick={finish} disabled={!confirmed || !saved} loading={setup.isPending}>
        Finish setup
      </Button>
    </Stack>
  );
}

/** Nothing reaches the board until the recovery key has been shown and confirmed. */
export function SetupScreen({ owner, onComplete, onImporting, kdf = PRODUCTION_KDF }: Props) {
  const [ready, setReady] = useState<Ready | null>(null);
  const [importing, setImporting] = useState(false);
  return (
    <Center mih="100vh" p="md">
      <Paper withBorder p="xl" maw={560} w="100%">
        <Stack>
          <Group gap="xs">
            <IconLock size={22} />
            <Title order={3}>Set up encryption</Title>
          </Group>
          {importing ? (
            <ImportSetup
              owner={owner}
              onComplete={onComplete}
              onBack={() => setImporting(false)}
              onImporting={(on) => onImporting?.(on)}
            />
          ) : ready === null ? (
            <>
              <PassphraseStep owner={owner} kdf={kdf} onReady={setReady} />
              <Anchor component="button" type="button" size="sm" onClick={() => setImporting(true)}>
                Import a board export instead
              </Anchor>
            </>
          ) : (
            <RecoveryStep ready={ready} onComplete={onComplete} />
          )}
        </Stack>
      </Paper>
    </Center>
  );
}
