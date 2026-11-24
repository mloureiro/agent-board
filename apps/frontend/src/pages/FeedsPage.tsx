import {
  feedRequest,
  formatDuration,
  type FeedAction,
  type FeedOutcome,
  type FeedRun,
  type MachineFeed,
} from '@agent-board/shared';
import { Anchor, Badge, Button, Code, Collapse, Group, Paper, Stack, Table, Text, Title } from '@mantine/core';
import { useDisclosure, useId } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { QueryStatus } from '../components/QueryStatus';
import { feedStatus } from '../lib/feedStatus';
import type { OpenedFeeds } from '@agent-board/shared/ui';
import { ago, stamp } from '../lib/time';
import { errorMessage, POLL_MS, useTRPC } from '../lib/trpc';
import { useNow } from '../lib/useNow';

const WAITING: Record<FeedAction, string> = { pause: 'Pausing…', resume: 'Resuming…', run: 'Run asked for…' };

const OUTCOME_COLOR: Record<FeedOutcome, string> = {
  created: 'green',
  requeued: 'blue',
  rescheduled: 'grape',
  closed: 'gray',
};

function counts(run: FeedRun): string {
  const parts = [`${run.listed} listed`, `${run.created} created`, `${run.requeued} requeued`, `${run.closed} closed`];
  return run.failed > 0 ? [...parts, `${run.failed} failed`].join(', ') : parts.join(', ');
}

function runSummary(feed: MachineFeed, errorShown: boolean): string {
  const { last } = feed;
  if (last === undefined) return 'Never run.';
  if (last.ok) return counts(last);
  const outcome = last.invalid === true ? 'Invalid' : 'Failed';
  const reason = errorShown ? '' : `: ${last.error ?? 'unknown error'}`;
  return `${outcome}${reason}${last.listed > 0 ? ` (${counts(last)})` : ''}`;
}

function FeedActions({ machine, feed, requests }: { machine: string; feed: MachineFeed; requests: string[] }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const request = useMutation({
    ...trpc.feeds.request.mutationOptions(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.feeds.list.queryOptions().queryKey }),
  });
  const pending = (action: FeedAction): boolean => requests.includes(feedRequest(action, feed.id));
  const ask = (action: FeedAction) => request.mutate({ machine, action, id: feed.id });
  const toggle: FeedAction = feed.paused ? 'resume' : 'pause';
  const unreadable = feed.problem !== undefined;
  return (
    <Stack gap={4} align="flex-end">
      <Group gap="xs" wrap="nowrap">
        <Button
          size="compact-sm"
          variant="light"
          color="gray"
          disabled={unreadable || pending('run') || feed.runAsked}
          loading={request.isPending && request.variables.action === 'run'}
          onClick={() => ask('run')}
        >
          Run now
        </Button>
        <Button
          size="compact-sm"
          variant="light"
          color="gray"
          disabled={unreadable || pending(toggle)}
          loading={request.isPending && request.variables.action === toggle}
          onClick={() => ask(toggle)}
        >
          {feed.paused ? 'Resume' : 'Pause'}
        </Button>
      </Group>
      {(['pause', 'resume', 'run'] as const)
        .filter((action) => pending(action))
        .map((action) => (
          <Text key={action} size="xs" c="dimmed">
            {WAITING[action]}
          </Text>
        ))}
      {request.isError && (
        <Text size="xs" c="red">
          {errorMessage(request.error)}
        </Text>
      )}
    </Stack>
  );
}

function Tasks({ feed, titles }: { feed: MachineFeed; titles: Map<string, string> }) {
  const tasks = feed.last?.tasks ?? [];
  if (tasks.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        The last run touched no task.
      </Text>
    );
  }
  return (
    <Stack gap={4}>
      {tasks.map(({ id, outcome }) => (
        <Group key={id} gap="xs" wrap="nowrap">
          <Badge size="xs" variant="light" color={OUTCOME_COLOR[outcome]} style={{ flexShrink: 0 }}>
            {outcome}
          </Badge>
          <Anchor component={Link} to={`/t/${id}`} size="sm" lineClamp={1}>
            {titles.get(id) ?? id}
          </Anchor>
        </Group>
      ))}
    </Stack>
  );
}

function History({ feed }: { feed: MachineFeed }) {
  if (feed.history.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        No run recorded yet.
      </Text>
    );
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Started</Table.Th>
            <Table.Th>Result</Table.Th>
            <Table.Th>Items</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {feed.history.map((run) => (
            <Table.Tr key={run.startedAt}>
              <Table.Td style={{ whiteSpace: 'nowrap' }}>{stamp(run.startedAt)}</Table.Td>
              <Table.Td c={run.ok ? undefined : 'red'}>
                {run.invalid === true ? 'invalid' : run.ok ? 'ok' : 'failed'}
                {run.error === undefined ? '' : `: ${run.error}`}
              </Table.Td>
              <Table.Td style={{ whiteSpace: 'nowrap' }}>{counts(run)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </div>
  );
}

function FeedCard({
  machine,
  feed,
  requests,
  titles,
  now,
}: {
  machine: string;
  feed: MachineFeed;
  requests: string[];
  titles: Map<string, string>;
  now: number;
}) {
  const [open, { toggle }] = useDisclosure(false);
  const panelId = useId();
  const status = feedStatus(feed, now);
  const what = feed.integration === undefined ? undefined : `${feed.integration} · ${feed.action ?? 'unknown action'}`;
  return (
    <Paper withBorder p="sm">
      <Stack gap="xs">
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
          <Stack gap={2} miw={0} style={{ flex: '1 1 240px' }}>
            <Group gap="xs">
              <Text fw={500}>{feed.name}</Text>
              {status !== undefined && (
                <Badge size="sm" variant="light" color={status.color}>
                  {status.label}
                </Badge>
              )}
            </Group>
            <Text size="xs" c="dimmed">
              {what === undefined ? '' : `${what} · `}every {formatDuration(feed.everyMs)}
            </Text>
            {status?.detail !== undefined && (
              <Text size="sm" c={status.color === 'red' ? 'red' : 'dimmed'}>
                {status.detail}
              </Text>
            )}
          </Stack>
          <FeedActions machine={machine} feed={feed} requests={requests} />
        </Group>
        <Text size="sm" c={feed.last?.ok === false ? 'red' : undefined}>
          {feed.last === undefined ? '' : `Last run ${ago(feed.last.startedAt)}. `}
          {runSummary(feed, status?.detail !== undefined && status.detail === feed.last?.error)}
        </Text>
        <div>
          <Button
            variant="subtle"
            size="compact-xs"
            onClick={toggle}
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={`${open ? 'Hide' : 'Show'} details of ${feed.name}`}
          >
            {open ? 'Hide details' : 'Show details'}
          </Button>
        </div>
        <Collapse expanded={open} id={panelId}>
          <Stack gap="md" pt="xs">
            <Stack gap={4}>
              <Text size="sm" fw={500}>
                Tasks of the last run
              </Text>
              <Tasks feed={feed} titles={titles} />
            </Stack>
            <Stack gap={4}>
              <Text size="sm" fw={500}>
                Last runs
              </Text>
              <History feed={feed} />
            </Stack>
          </Stack>
        </Collapse>
      </Stack>
    </Paper>
  );
}

function MachineFeeds({ entry, titles, now }: { entry: OpenedFeeds; titles: Map<string, string>; now: number }) {
  return (
    <Stack gap="xs">
      <Group gap="xs">
        <Title order={6}>{entry.machine}</Title>
        <Text size="xs" c="dimmed">
          {entry.lastSeenAt === null ? 'never seen' : `last seen ${ago(entry.lastSeenAt)}`}
          {entry.updatedAt === null ? '' : ` · feeds sent ${ago(entry.updatedAt)}`}
        </Text>
      </Group>
      {entry.feeds === null ? (
        <Text size="sm" c="dimmed">
          The feeds of this machine cannot be read here.
        </Text>
      ) : (
        entry.feeds.map((feed) => (
          <FeedCard
            key={feed.id}
            machine={entry.machine}
            feed={feed}
            requests={entry.requests}
            titles={titles}
            now={now}
          />
        ))
      )}
    </Stack>
  );
}

export function FeedsPage() {
  const trpc = useTRPC();
  const now = useNow(30_000);
  const feeds = useQuery({ ...trpc.feeds.list.queryOptions(), refetchInterval: POLL_MS });
  const tasks = useQuery(trpc.tasks.list.queryOptions());
  const titles = new Map((tasks.data ?? []).map((task) => [task.id, task.title]));
  const machines = (feeds.data ?? []).filter((entry) => entry.feeds === null || entry.feeds.length > 0);
  return (
    <Stack>
      <Title order={5}>Feeds</Title>
      <Text size="sm" c="dimmed">
        A feed runs an integration from an installed plugin on a timer to make tasks from another tool, one task per
        item it lists. Each machine shows its own; its integration, options and tokens stay on the machine. Pause,
        Resume and Run now reach the machine on its next tick. Add one with <Code>board feeds add</Code>.
      </Text>
      <QueryStatus query={feeds} what="feeds" />
      {machines.length === 0
        ? feeds.data !== undefined && (
            <Text size="sm" c="dimmed">
              No machine sent feeds. Install a plugin with <Code>board plugins install</Code> and add a feed with{' '}
              <Code>board feeds add</Code> on a machine.
            </Text>
          )
        : machines.map((entry) => <MachineFeeds key={entry.machine} entry={entry} titles={titles} now={now} />)}
    </Stack>
  );
}
