import { Alert, Button, Center, Code, Paper, Stack, Text, TextInput, Title } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useState } from 'react';
import { shownUserName } from '@agent-board/shared/ui';

export const FORGET_WORD = 'FORGET';

interface Props {
  held: { owner: string; keyId: string };
  reported: { username: string; keyId: string | null };
  /** Deletes this browser's key. Only the deliberate way out calls it. */
  onForget: () => Promise<void>;
}

function whatChanged({ held, reported }: Pick<Props, 'held' | 'reported'>): string {
  if (reported.username !== held.owner) {
    const name = shownUserName(reported.username);
    return `The board says you are ${name ?? 'someone else'}, but this browser holds the key of ${held.owner}.`;
  }
  if (reported.keyId === null) return 'The board says no key is set up for you.';
  return `The board says your key has the id ${reported.keyId}.`;
}

/**
 * The board's record of the user's key does not match the key this browser holds. That is what a reset looks like, and also what
 * a board that cannot be trusted would say to get a second key set up, so nothing is offered but waiting and a deliberate exit.
 */
export function KeyChangedScreen({ held, reported, onForget }: Props) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Center mih="100vh" p="md">
      <Paper withBorder p="xl" maw={560} w="100%">
        <Stack>
          <Title order={3}>The board’s record of your key changed</Title>
          <Alert
            color="red"
            icon={<IconAlertTriangle size={18} />}
            title="Do not set up a new key unless you reset the board yourself"
          >
            <Stack gap="xs">
              <Text size="sm">{whatChanged({ held, reported })}</Text>
              <Text size="sm">
                This browser holds your key with the id <Code>{held.keyId}</Code>, and your worker machines hold the
                same one. A new key set up now would not open anything stored under it, and your machines would keep
                using the old one. Nothing was deleted and nothing is sent while this page is shown.
              </Text>
              <Text size="sm">
                If you did not reset the board, do not continue: ask whoever runs it what happened. If you did, you can
                forget this browser’s key below and set up the board again.
              </Text>
            </Stack>
          </Alert>
          <TextInput
            label={`To forget this browser’s key, type ${FORGET_WORD}`}
            value={typed}
            onChange={(event) => setTyped(event.currentTarget.value)}
            autoComplete="off"
          />
          <Button
            color="red"
            variant="light"
            disabled={typed !== FORGET_WORD}
            loading={busy}
            onClick={() => {
              setBusy(true);
              void onForget().finally(() => setBusy(false));
            }}
          >
            Forget this browser’s key
          </Button>
        </Stack>
      </Paper>
    </Center>
  );
}
