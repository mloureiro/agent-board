import { Button, Center, Group, Loader, Paper, Stack, Text, Title } from '@mantine/core';
import { IconDeviceDesktopCheck } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { errorMessage, useRawTRPC, useRawTRPCClient, useTRPC } from '../lib/trpc';
import { isUnauthorized } from '../lib/unauthorized';
import { LoginPage } from './LoginPage';
import { useAttempt } from './useAttempt';

function Card({ children }: { children: React.ReactNode }) {
  return (
    <Center mih="100vh" p="md">
      <Paper withBorder p="xl" maw={480} w="100%">
        <Stack>
          <Group gap="xs">
            <IconDeviceDesktopCheck size={22} />
            <Title order={3}>Sign in an Agent Board window</Title>
          </Group>
          {children}
        </Stack>
      </Paper>
    </Center>
  );
}

function Approval({ flow, username }: { flow: string; username: string }) {
  const raw = useRawTRPC();
  const client = useRawTRPCClient();
  const described = useQuery({ ...raw.auth.handoff.describe.queryOptions({ flow }), retry: false });
  const { busy, error, run } = useAttempt();
  const [approved, setApproved] = useState(false);

  if (approved) {
    return (
      <Card>
        <Text>Approved. Go back to the app window; it signs in by itself.</Text>
      </Card>
    );
  }
  return (
    <Card>
      {described.isLoading && <Loader size="sm" />}
      {described.error && (
        <Text c="red" size="sm" role="alert">
          {errorMessage(described.error)}
        </Text>
      )}
      {described.data && (
        <>
          <Stack gap={2}>
            <Text size="sm" c="dimmed">
              Code
            </Text>
            <Text size="xl" fw={700} ff="monospace" data-testid="handoff-code">
              {described.data.code}
            </Text>
          </Stack>
          <Text size="sm">
            Approving signs in an Agent Board window as <strong>{username}</strong>. Approve only if you started this
            sign-in and the window shows the same code.
          </Text>
          {error && (
            <Text c="red" size="sm" role="alert">
              {error}
            </Text>
          )}
          <Button
            loading={busy}
            onClick={() =>
              void run(async () => {
                await client.auth.handoff.approve.mutate({ flow });
                setApproved(true);
              })
            }
          >
            Approve
          </Button>
        </>
      )}
    </Card>
  );
}

/**
 * Where the link from an Agent Board window lands, in a full browser: signs in when needed, then waits for the user to
 * approve the window that shows the same code. Nothing is approved on load.
 */
export function HandoffApproval() {
  const { flow = '' } = useParams();
  const trpc = useTRPC();
  const me = useQuery({ ...trpc.me.queryOptions(), retry: false });

  if (isUnauthorized(me.error)) return <LoginPage />;
  if (me.data === undefined) {
    return me.error ? (
      <Card>
        <Text c="red" size="sm" role="alert">
          {errorMessage(me.error)}
        </Text>
      </Card>
    ) : (
      <Card>
        <Loader size="sm" />
      </Card>
    );
  }
  return <Approval flow={flow} username={me.data.username} />;
}
