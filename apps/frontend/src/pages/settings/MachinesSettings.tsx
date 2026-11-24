import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
  CopyButton,
  Group,
  Paper,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { INVALID_VALUE, isSafeMachineName, MACHINE_NAME_RULE } from '@agent-board/shared';
import { modals } from '@mantine/modals';
import { IconCheck, IconCopy, IconKey } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { KeyError } from '@agent-board/shared/ui';
import { exportDataKey } from '../../crypto/unlocker';
import { useKeys } from '../../crypto/KeyContext';
import { PassphraseModal } from '../../crypto/PassphraseModal';
import { CLIENT_COLOR, clientText } from '../../lib/clientStatus';
import { MachineUsageLines } from '../../components/MachineUsageLines';
import { QueryStatus } from '../../components/QueryStatus';
import { ago } from '../../lib/time';
import { useTRPC } from '../../lib/trpc';
import { useNow } from '../../lib/useNow';
import { asHeld } from './asHeld';

interface Enrolment {
  name: string;
  token: string | null;
  dataKey: string;
}

const envLines = ({ token, dataKey }: Enrolment): string[] => [
  ...(token === null ? [] : [`AGENT_BOARD_TOKEN=${token}`]),
  `AGENT_BOARD_DATA_KEY=${dataKey}`,
];

function Machines() {
  const trpc = useTRPC();
  const machines = useQuery(trpc.machines.list.queryOptions());
  const now = useNow(30_000);
  const advertised = useQuery(trpc.machines.advertisedCli.queryOptions());
  const issue = useMutation(trpc.machines.issue.mutationOptions());
  const revoke = useMutation(trpc.machines.revoke.mutationOptions());
  const keys = useKeys();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [issued, setIssued] = useState<Enrolment | null>(null);
  const [asking, setAsking] = useState<{ name: string; issuing: boolean } | null>(null);
  // Checked here so a bad name fails before the passphrase prompt, not after it in the server's reply.
  const machineName = name.trim();
  const nameError = machineName !== '' && !isSafeMachineName(machineName) ? `Use ${MACHINE_NAME_RULE}` : undefined;

  // The passphrase is checked before a token is issued, so a wrong one leaves the machine's old token alone.
  const enrol = async (passphrase: string) => {
    const stored = await queryClient.fetchQuery(trpc.keys.get.queryOptions());
    if (!asking || !keys || !stored) throw new KeyError('The key is not available. Reload the page.');
    const dataKey = await exportDataKey({ owner: keys.owner, stored: asHeld(stored, keys), passphrase });
    const token = asking.issuing ? (await issue.mutateAsync({ name: asking.name })).token : null;
    setIssued({ name: asking.name, token, dataKey });
    setName('');
    setAsking(null);
  };
  const create = (target: string) => setAsking({ name: target, issuing: true });
  // A new token for a machine that has one stops the old one at once.
  const issueFor = (target: string) =>
    machines.data?.some((m) => m.name === target)
      ? modals.openConfirmModal({
          title: `New token for ${target}?`,
          children: (
            <Text size="sm">
              The old token stops working at once; put the new one on {target} or its dispatcher fails.
            </Text>
          ),
          labels: { confirm: 'New token', cancel: 'Cancel' },
          confirmProps: { color: 'red' },
          onConfirm: () => create(target),
        })
      : create(target);

  return (
    <Paper withBorder p="md">
      <Stack>
        <div>
          <Title order={5}>Worker machines</Title>
          <Text size="sm" c="dimmed">
            Each machine that runs <Code>dispatch</Code> gets a token. Its name must match <Code>machine</Code> in its
            config.json (default: the host name).
            {advertised.data ? <> The newest CLI is {advertised.data}.</> : null}
          </Text>
        </div>
        {asking && (
          <PassphraseModal
            title={asking.issuing ? `Token for ${asking.name}` : `Data key for ${asking.name}`}
            description={
              <>
                The machine needs your data key to read and write the board. Enter your passphrase to show it
                {asking.issuing ? ' with the new token' : ''}.
              </>
            }
            confirmLabel={asking.issuing ? 'Create token' : 'Show data key'}
            onClose={() => setAsking(null)}
            onSubmit={enrol}
          />
        )}
        {issued && (
          <Alert
            color="teal"
            icon={<IconKey size={18} />}
            title={`${issued.token === null ? 'Data key' : 'Token and data key'} for ${issued.name}, shown once`}
            withCloseButton
            onClose={() => setIssued(null)}
          >
            <Stack gap="xs">
              <Text size="sm">
                Put {issued.token === null ? 'it' : 'both lines'} in <Code>~/.config/agent-board/env</Code> (mode 600)
                on that machine. The data key opens everything on the board: keep it as secret as the passphrase.
              </Text>
              <Group gap="xs" wrap="nowrap">
                <Code block style={{ flex: 1, overflowX: 'auto' }}>
                  {envLines(issued).join('\n')}
                </Code>
                <CopyButton value={envLines(issued).join('\n')}>
                  {({ copied, copy }) => (
                    <Tooltip label={copied ? 'Copied' : 'Copy'}>
                      <ActionIcon variant="default" onClick={copy} size="lg">
                        {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                      </ActionIcon>
                    </Tooltip>
                  )}
                </CopyButton>
              </Group>
            </Stack>
          </Alert>
        )}
        <QueryStatus query={machines} what="machines" />
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>CLI</Table.Th>
              <Table.Th>Last seen</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(machines.data ?? []).map((m) => (
              <Table.Tr key={m.name}>
                <Table.Td>
                  <Group gap="xs">
                    <Text size="sm">{m.shown}</Text>
                    {m.revokedAt && (
                      <Badge size="xs" color="red" variant="light">
                        revoked
                      </Badge>
                    )}
                  </Group>
                  <MachineUsageLines machine={m} now={now} />
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c={CLIENT_COLOR[m.clientStatus]}>
                    {clientText(m)}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    {m.lastSeenAt ? ago(m.lastSeenAt) : 'never'}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Group gap="xs" justify="flex-end">
                    {m.shown !== INVALID_VALUE && (
                      <Button size="xs" variant="default" onClick={() => issueFor(m.name)}>
                        New token
                      </Button>
                    )}
                    {!m.revokedAt && m.shown !== INVALID_VALUE && (
                      <Button size="xs" variant="default" onClick={() => setAsking({ name: m.name, issuing: false })}>
                        Show data key
                      </Button>
                    )}
                    {!m.revokedAt && (
                      <Button
                        size="xs"
                        variant="subtle"
                        color="red"
                        onClick={() =>
                          modals.openConfirmModal({
                            title: m.shown === INVALID_VALUE ? 'Revoke this machine’s token?' : `Revoke ${m.shown}?`,
                            children: <Text size="sm">Its dispatcher stops working until it gets a new token.</Text>,
                            labels: { confirm: 'Revoke', cancel: 'Cancel' },
                            confirmProps: { color: 'red' },
                            onConfirm: () => revoke.mutate({ name: m.name }),
                          })
                        }
                      >
                        Revoke
                      </Button>
                    )}
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Group align="flex-end">
          <TextInput
            label="Add a machine"
            description={`A name of ${MACHINE_NAME_RULE}`}
            placeholder="laptop"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            error={nameError}
            style={{ flex: 1 }}
          />
          <Button onClick={() => issueFor(machineName)} disabled={machineName === '' || nameError !== undefined}>
            Create token
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

export function MachinesSettings() {
  return <Machines />;
}
