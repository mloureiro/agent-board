import { describeRule, formatDuration, INVALID_VALUE, runsLeft } from '@agent-board/shared';
import { ActionIcon, Anchor, Badge, Code, Group, Paper, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { modals } from '@mantine/modals';
import { IconPencil, IconPlayerPause, IconPlayerPlay, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { EditScheduleModal } from '../components/EditSchedule';
import { QueryStatus } from '../components/QueryStatus';
import { usePageTitle } from '../components/usePageTitle';
import { ago, stamp } from '../lib/time';
import { POLL_MS, useTRPC, type Schedule as ScheduleRow } from '../lib/trpc';

function ScheduleActions({ schedule }: { schedule: ScheduleRow }) {
  const trpc = useTRPC();
  const setPaused = useMutation(trpc.schedules.setPaused.mutationOptions());
  const remove = useMutation(trpc.schedules.remove.mutationOptions());
  const [editing, setEditing] = useState(false);
  const confirmRemove = () =>
    modals.openConfirmModal({
      title: `Delete "${schedule.title}"?`,
      children: (
        <Text size="sm">
          The waiting run is removed and nothing repeats any more. Tasks that already ran stay on the board.
        </Text>
      ),
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate({ id: schedule.id }),
    });
  return (
    <Group gap={4} justify="flex-end" wrap="nowrap">
      {!schedule.ended && (
        <Tooltip label="Edit">
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label="Edit"
            disabled={schedule.unreadable.length > 0}
            onClick={() => setEditing(true)}
          >
            <IconPencil size={16} />
          </ActionIcon>
        </Tooltip>
      )}
      {!schedule.ended && (
        <Tooltip label={schedule.paused ? 'Resume' : 'Pause'}>
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label={schedule.paused ? 'Resume' : 'Pause'}
            loading={setPaused.isPending}
            onClick={() => setPaused.mutate({ id: schedule.id, paused: !schedule.paused })}
          >
            {schedule.paused ? <IconPlayerPlay size={16} /> : <IconPlayerPause size={16} />}
          </ActionIcon>
        </Tooltip>
      )}
      <Tooltip label="Delete">
        <ActionIcon variant="subtle" color="red" aria-label="Delete" loading={remove.isPending} onClick={confirmRemove}>
          <IconTrash size={16} />
        </ActionIcon>
      </Tooltip>
      <EditScheduleModal schedule={schedule} opened={editing} onClose={() => setEditing(false)} />
    </Group>
  );
}

/** The title of the schedule `id`, or the id when it is not in the list (gone, or not readable). */
function titleOf(id: string, all: readonly ScheduleRow[]): string {
  const found = all.find((candidate) => candidate.id === id);
  return found === undefined || found.unreadable.includes('title') ? id : found.title;
}

function describeSchedule(schedule: ScheduleRow, all: readonly ScheduleRow[]): string {
  if (schedule.invalid.includes('everyMs')) return INVALID_VALUE;
  if (schedule.after === null) return describeRule(schedule);
  const { scheduleId, delayMs } = schedule.after;
  return `after ${titleOf(scheduleId, all)}${delayMs > 0 ? ` +${formatDuration(delayMs)}` : ''}`;
}

function ScheduleRowView({ schedule, all }: { schedule: ScheduleRow; all: readonly ScheduleRow[] }) {
  return (
    <Table.Tr style={{ opacity: schedule.ended ? 0.55 : undefined }}>
      <Table.Td maw={320}>
        <Group gap="xs" wrap="nowrap">
          <Text size="sm" truncate>
            {schedule.title}
          </Text>
          {schedule.paused && (
            <Badge size="xs" color="yellow" variant="light">
              paused
            </Badge>
          )}
          {schedule.ended && (
            <Badge size="xs" color="gray" variant="light">
              ended
            </Badge>
          )}
        </Group>
        <Text size="xs" c="dimmed" truncate>
          {schedule.input}
        </Text>
      </Table.Td>
      <Table.Td>
        <Text size="sm">{describeSchedule(schedule, all)}</Text>
        {schedule.maxConcurrent !== null && (
          <Text size="xs" c="dimmed">
            At most {schedule.maxConcurrent} at once
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        {schedule.nextRunAt ? (
          <Text size="sm">
            {stamp(schedule.nextRunAt)}{' '}
            <Text span size="xs" c="dimmed">
              {ago(schedule.nextRunAt)}
            </Text>
          </Text>
        ) : (
          <Text size="sm" c={schedule.occurrenceTaskId ? undefined : 'dimmed'}>
            {schedule.occurrenceTaskId
              ? 'now'
              : schedule.after !== null && !schedule.paused && !schedule.ended
                ? `waits for ${titleOf(schedule.after.scheduleId, all)}`
                : '-'}
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        <Text size="sm">
          {schedule.invalid.includes('remaining')
            ? INVALID_VALUE
            : (runsLeft(schedule) ?? (schedule.until ? `until ${stamp(schedule.until)}` : 'forever'))}
        </Text>
      </Table.Td>
      <Table.Td>
        <Text size="sm" c={schedule.machine ? undefined : 'dimmed'}>
          {schedule.machine ?? 'any'}
        </Text>
      </Table.Td>
      <Table.Td>
        {schedule.occurrenceTaskId ? (
          <Anchor component={Link} to={`/t/${schedule.occurrenceTaskId}`} size="sm">
            Next card
          </Anchor>
        ) : (
          <Text size="sm" c="dimmed">
            -
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        <ScheduleActions schedule={schedule} />
      </Table.Td>
    </Table.Tr>
  );
}

export function SchedulesPage() {
  usePageTitle('Schedules');
  const trpc = useTRPC();
  const schedules = useQuery({ ...trpc.schedules.list.queryOptions(), refetchInterval: POLL_MS });
  const rows = schedules.data ?? [];
  return (
    <Stack maw={1100} mx="auto">
      <Title order={3}>Schedules</Title>
      <Text size="sm" c="dimmed">
        Each schedule keeps one pending card on the board; the next one appears when that card is started, moved or
        closed. Runs missed while nothing took the card are skipped. A schedule that runs after another has no card
        until a card of that one finishes. Make one with New task, When: Repeating, or{' '}
        <Code>board schedule --every</Code>.
      </Text>
      <QueryStatus query={schedules} what="schedules" />
      <Paper withBorder style={{ overflowX: 'auto' }}>
        {rows.length === 0 ? (
          schedules.data !== undefined && (
            <Text size="sm" c="dimmed" p="md">
              No schedules yet.
            </Text>
          )
        ) : (
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Title</Table.Th>
                <Table.Th>Rule</Table.Th>
                <Table.Th>Next run</Table.Th>
                <Table.Th>Runs left</Table.Th>
                <Table.Th>Machine</Table.Th>
                <Table.Th>Card</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((schedule) => (
                <ScheduleRowView key={schedule.id} schedule={schedule} all={rows} />
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Paper>
    </Stack>
  );
}
