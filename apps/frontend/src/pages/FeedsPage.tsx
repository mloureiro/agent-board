import { formatDuration, feedRequest, type MachineFeed, type FeedAction } from '@agent-board/shared';
import { ActionIcon, Badge, Code, Group, Paper, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { IconPlayerPause, IconPlayerPlay, IconRefresh } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { QueryStatus } from '../components/QueryStatus';
import type { OpenedFeeds } from '../lib/opening';
import { ago, stamp } from '../lib/time';
import { POLL_MS, useTRPC } from '../lib/trpc';

const WAITING: Record<FeedAction, string> = { pause: 'Pausing…', resume: 'Resuming…', run: 'Run asked for…' };

function lastRun(feed: MachineFeed): string {
  const { last } = feed;
  if (last === undefined) return 'never run';
  const counts = `${last.listed} listed, ${last.created} created, ${last.requeued} requeued, ${last.closed} closed${last.failed > 0 ? `, ${last.failed} failed` : ''}`;
  return last.ok ? counts : `failed: ${last.error ?? 'unknown error'}${last.listed > 0 ? ` (${counts})` : ''}`;
}

function FeedActions({ machine, feed, requests }: { machine: string; feed: MachineFeed; requests: string[] }) {
  const trpc = useTRPC();
  const request = useMutation(trpc.feeds.request.mutationOptions());
  const pending = (action: FeedAction): boolean => requests.includes(feedRequest(action, feed.id));
  const ask = (action: FeedAction) => request.mutate({ machine, action, id: feed.id });
  const toggle: FeedAction = feed.paused ? 'resume' : 'pause';
  return (
    <Group gap={4} justify="flex-end" wrap="nowrap">
      <Tooltip label={pending('run') || feed.runNow ? WAITING.run : 'Run now'}>
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label="Run now"
          disabled={feed.problem !== undefined || pending('run') || feed.runNow}
          onClick={() => ask('run')}
        >
          <IconRefresh size={16} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label={pending(toggle) ? WAITING[toggle] : feed.paused ? 'Resume' : 'Pause'}>
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={feed.paused ? 'Resume' : 'Pause'}
          disabled={feed.problem !== undefined || pending(toggle)}
          loading={request.isPending}
          onClick={() => ask(toggle)}
        >
          {feed.paused ? <IconPlayerPlay size={16} /> : <IconPlayerPause size={16} />}
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}

function FeedRow({ machine, feed, requests }: { machine: string; feed: MachineFeed; requests: string[] }) {
  const waiting = (['pause', 'resume', 'run'] as const).find((action) =>
    requests.includes(feedRequest(action, feed.id)),
  );
  return (
    <Table.Tr>
      <Table.Td>
        <Group gap="xs" wrap="nowrap">
          <Text size="sm">{feed.name}</Text>
          {feed.paused && (
            <Badge size="xs" color="yellow" variant="light">
              paused
            </Badge>
          )}
          {feed.problem !== undefined && (
            <Badge size="xs" color="red" variant="light">
              not read
            </Badge>
          )}
          {feed.last !== undefined && !feed.last.ok && feed.problem === undefined && (
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
        <Text size="sm">{feed.problem === undefined ? `every ${formatDuration(feed.everyMs)}` : '-'}</Text>
      </Table.Td>
      <Table.Td>
        {feed.last === undefined ? (
          <Text size="sm" c="dimmed">
            -
          </Text>
        ) : (
          <Text size="sm">
            {stamp(feed.last.at)}{' '}
            <Text span size="xs" c="dimmed">
              {ago(feed.last.at)}
            </Text>
          </Text>
        )}
      </Table.Td>
      <Table.Td maw={420}>
        <Text size="sm" c={feed.problem !== undefined || feed.last?.ok === false ? 'red' : undefined}>
          {feed.problem ?? lastRun(feed)}
        </Text>
      </Table.Td>
      <Table.Td>
        <FeedActions machine={machine} feed={feed} requests={requests} />
      </Table.Td>
    </Table.Tr>
  );
}

function MachineFeeds({ entry }: { entry: OpenedFeeds }) {
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
        {entry.feeds === null ? (
          <Text size="sm" c="dimmed" p="md">
            The feeds of this machine cannot be read here.
          </Text>
        ) : (
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Feed</Table.Th>
                <Table.Th>Timer</Table.Th>
                <Table.Th>Last run</Table.Th>
                <Table.Th>Result</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {entry.feeds.map((feed) => (
                <FeedRow key={feed.id} machine={entry.machine} feed={feed} requests={entry.requests} />
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Paper>
    </Stack>
  );
}

export function FeedsPage() {
  const trpc = useTRPC();
  const feeds = useQuery({ ...trpc.feeds.list.queryOptions(), refetchInterval: POLL_MS });
  const machines = (feeds.data ?? []).filter((entry) => entry.feeds === null || entry.feeds.length > 0);
  return (
    <Stack maw={1100} mx="auto">
      <Title order={3}>Feeds</Title>
      <Text size="sm" c="dimmed">
        A feed is a command a machine runs on a timer to make tasks from another tool, one task per item it lists. Each
        machine shows its own; the commands stay on the machine. Pause, Resume and Run now reach the machine on its next
        tick. Add one with <Code>board feeds add</Code>.
      </Text>
      <QueryStatus query={feeds} what="feeds" />
      {machines.length === 0
        ? feeds.data !== undefined && (
            <Text size="sm" c="dimmed">
              No feeds yet.
            </Text>
          )
        : machines.map((entry) => <MachineFeeds key={entry.machine} entry={entry} />)}
    </Stack>
  );
}
