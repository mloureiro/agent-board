import { formatDuration, sourceRequest, type MachineSource, type SourceAction } from '@agent-board/shared';
import { ActionIcon, Badge, Code, Group, Paper, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { IconPlayerPause, IconPlayerPlay, IconRefresh } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { QueryStatus } from '../components/QueryStatus';
import type { OpenedSources } from '../lib/opening';
import { ago, stamp } from '../lib/time';
import { POLL_MS, useTRPC } from '../lib/trpc';

const WAITING: Record<SourceAction, string> = { pause: 'Pausing…', resume: 'Resuming…', run: 'Run asked for…' };

function lastRun(source: MachineSource): string {
  const { last } = source;
  if (last === undefined) return 'never run';
  const counts = `${last.listed} listed, ${last.created} created, ${last.requeued} requeued, ${last.closed} closed${last.failed > 0 ? `, ${last.failed} failed` : ''}`;
  return last.ok ? counts : `failed: ${last.error ?? 'unknown error'}${last.listed > 0 ? ` (${counts})` : ''}`;
}

function SourceActions({ machine, source, requests }: { machine: string; source: MachineSource; requests: string[] }) {
  const trpc = useTRPC();
  const request = useMutation(trpc.sources.request.mutationOptions());
  const pending = (action: SourceAction): boolean => requests.includes(sourceRequest(action, source.id));
  const ask = (action: SourceAction) => request.mutate({ machine, action, id: source.id });
  const toggle: SourceAction = source.paused ? 'resume' : 'pause';
  return (
    <Group gap={4} justify="flex-end" wrap="nowrap">
      <Tooltip label={pending('run') || source.runNow ? WAITING.run : 'Run now'}>
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label="Run now"
          disabled={source.problem !== undefined || pending('run') || source.runNow}
          onClick={() => ask('run')}
        >
          <IconRefresh size={16} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label={pending(toggle) ? WAITING[toggle] : source.paused ? 'Resume' : 'Pause'}>
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={source.paused ? 'Resume' : 'Pause'}
          disabled={source.problem !== undefined || pending(toggle)}
          loading={request.isPending}
          onClick={() => ask(toggle)}
        >
          {source.paused ? <IconPlayerPlay size={16} /> : <IconPlayerPause size={16} />}
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}

function SourceRow({ machine, source, requests }: { machine: string; source: MachineSource; requests: string[] }) {
  const waiting = (['pause', 'resume', 'run'] as const).find((action) =>
    requests.includes(sourceRequest(action, source.id)),
  );
  return (
    <Table.Tr>
      <Table.Td>
        <Group gap="xs" wrap="nowrap">
          <Text size="sm">{source.name}</Text>
          {source.paused && (
            <Badge size="xs" color="yellow" variant="light">
              paused
            </Badge>
          )}
          {source.problem !== undefined && (
            <Badge size="xs" color="red" variant="light">
              not read
            </Badge>
          )}
          {source.last !== undefined && !source.last.ok && source.problem === undefined && (
            <Badge size="xs" color="red" variant="light">
              failed
            </Badge>
          )}
        </Group>
        {waiting !== undefined && (
          <Text size="xs" c="dimmed">
            {WAITING[waiting]}
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        <Text size="sm">{source.problem === undefined ? `every ${formatDuration(source.everyMs)}` : '-'}</Text>
      </Table.Td>
      <Table.Td>
        {source.last === undefined ? (
          <Text size="sm" c="dimmed">
            -
          </Text>
        ) : (
          <Text size="sm">
            {stamp(source.last.at)}{' '}
            <Text span size="xs" c="dimmed">
              {ago(source.last.at)}
            </Text>
          </Text>
        )}
      </Table.Td>
      <Table.Td maw={420}>
        <Text size="sm" c={source.problem !== undefined || source.last?.ok === false ? 'red' : undefined}>
          {source.problem ?? lastRun(source)}
        </Text>
      </Table.Td>
      <Table.Td>
        <SourceActions machine={machine} source={source} requests={requests} />
      </Table.Td>
    </Table.Tr>
  );
}

function MachineSources({ entry }: { entry: OpenedSources }) {
  return (
    <Stack gap="xs">
      <Group gap="xs">
        <Title order={5}>{entry.machine}</Title>
        {entry.updatedAt !== null && (
          <Text size="xs" c="dimmed">
            sent {ago(entry.updatedAt)}
          </Text>
        )}
      </Group>
      <Paper withBorder style={{ overflowX: 'auto' }}>
        {entry.sources === null ? (
          <Text size="sm" c="dimmed" p="md">
            The sources of this machine cannot be read here.
          </Text>
        ) : (
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Source</Table.Th>
                <Table.Th>Timer</Table.Th>
                <Table.Th>Last run</Table.Th>
                <Table.Th>Result</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {entry.sources.map((source) => (
                <SourceRow key={source.id} machine={entry.machine} source={source} requests={entry.requests} />
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Paper>
    </Stack>
  );
}

export function SourcesPage() {
  const trpc = useTRPC();
  const sources = useQuery({ ...trpc.sources.list.queryOptions(), refetchInterval: POLL_MS });
  const machines = (sources.data ?? []).filter((entry) => entry.sources === null || entry.sources.length > 0);
  return (
    <Stack maw={1100} mx="auto">
      <Title order={3}>Sources</Title>
      <Text size="sm" c="dimmed">
        A source is a command a machine runs on a timer to make tasks from another tool, one task per item it lists.
        Each machine shows its own; the commands stay on the machine. Pause, Resume and Run now reach the machine on its
        next tick. Add one with <Code>board sources add</Code>.
      </Text>
      <QueryStatus query={sources} what="sources" />
      {machines.length === 0
        ? sources.data !== undefined && (
            <Text size="sm" c="dimmed">
              No sources yet.
            </Text>
          )
        : machines.map((entry) => <MachineSources key={entry.machine} entry={entry} />)}
    </Stack>
  );
}
