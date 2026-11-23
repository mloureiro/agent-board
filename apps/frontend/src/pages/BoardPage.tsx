import { isRecentFirst, type Status } from '@agent-board/shared';
import { Badge, Box, Button, Group, Paper, ScrollArea, Stack, Text } from '@mantine/core';
import { IconGitMerge } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Fragment, useState, type DragEvent } from 'react';
import { moveConfirmed } from '../components/confirmStart';
import { useDraftStore } from '../lib/draftsContext';
import { IncompatibleMachinesBanner } from '../components/IncompatibleMachinesBanner';
import { labelSuggestions } from '../components/LabelsEditor';
import { QueryStatus } from '../components/QueryStatus';
import { TaskCard } from '../components/TaskCard';
import { usePolish } from '../components/usePolish';
import { beforeIdOver, dropNeighbors } from '../lib/dropPosition';
import { canMoveMergedToDone } from '../lib/mergedPrs';
import { canPolish, isOpenPolishOf } from '../lib/polish';
import type { Proposal } from '../lib/sealing';
import { STATUS_COLOR, STATUS_LABEL } from '../lib/status';
import { POLL_MS, useTRPC, type ListedTask } from '../lib/trpc';
import { heldTask } from '../lib/usageHold';
import { useNow } from '../lib/useNow';

const HINT: Record<Status, string> = {
  backlog: 'Parked; no worker takes these',
  todo: 'By priority; top runs first',
  running: 'On a worker machine',
  waiting: 'On CI and the like; back to Todo by itself',
  'needs-me': 'Waiting for you; latest on top',
  done: 'Latest on top',
};

interface DropTarget {
  status: Status;
  /** The card the dragged one lands above; none means the bottom. */
  beforeId?: string;
}

/** Only a worker moves a task into or out of Running, and only a running agent puts one in Waiting (a drag out ends the wait). */
const canDrag = (task: ListedTask) => task.status !== 'running';
const canDrop = (status: Status) => status !== 'running' && status !== 'waiting';

/**
 * The board's cells in order; Waiting sits above Todo in one cell, so a wait never takes a column of its own, and is left out
 * while no task waits.
 */
const CELLS: Status[][] = [['backlog'], ['waiting', 'todo'], ['running'], ['needs-me'], ['done']];

/**
 * How tall a column's cards may grow before it scrolls. Waiting is capped at under a third of the viewport, and Todo below it
 * gets the rest of a full column less Waiting's box at its cap; without Waiting, Todo is as tall as any column.
 */
const scrollMaxHeight = (status: Status, waitingShown: boolean): string => {
  if (status === 'waiting') return '30vh';
  if (status === 'todo' && waitingShown) return 'calc(70vh - 230px)';
  return 'calc(100vh - 160px)';
};

/** Narrow on a wide screen until hovered, then they float over their neighbors at full width. */
const COLLAPSIBLE = new Set<Status>(['backlog', 'done']);

/** `only` renders just that column, on its own page instead of the board's grid. */
function BoardColumns({ only }: { only?: Status }) {
  const trpc = useTRPC();
  const tasks = useQuery({ ...trpc.tasks.list.queryOptions(), refetchInterval: POLL_MS });
  const suggestions = labelSuggestions(tasks.data ?? []);
  const machines = useQuery({ ...trpc.machines.list.queryOptions(), refetchInterval: POLL_MS });
  const now = useNow(30_000);
  const move = useMutation(trpc.tasks.move.mutationOptions());
  const done = useMutation(trpc.tasks.done.mutationOptions());
  const configure = useMutation(trpc.tasks.configure.mutationOptions());
  const polish = usePolish();
  const drafts = useDraftStore();
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<DropTarget | null>(null);

  const byStatus = (status: Status) => (tasks.data ?? []).filter((t) => t.status === status);
  const waitingShown = byStatus('waiting').length > 0;

  const moveMergedToDone = async () => {
    for (const { id } of byStatus('needs-me').filter(canMoveMergedToDone))
      await done.mutateAsync({ id }).catch(() => undefined);
  };

  const drop = (status: Status) => {
    if (!dragId || !canDrop(status)) return;
    const task = tasks.data?.find((t) => t.id === dragId);
    setDragId(null);
    setOver(null);
    // A column sorted by recency has no order to change, so a drop back into it changes nothing.
    if (isRecentFirst(status) && task?.status === status) return;
    const ids = byStatus(status).map((t) => t.id);
    const neighbors = isRecentFirst(status)
      ? {}
      : dropNeighbors(ids, dragId, over?.status === status ? over.beforeId : undefined);
    const run = (sent: Proposal | undefined = task) => move.mutate({ id: dragId, status, ...neighbors, task: sent });
    if (task === undefined) run();
    else moveConfirmed(task, status, drafts, run);
  };

  const renderColumn = (status: Status) => {
    const column = byStatus(status);
    return (
      <Paper
        withBorder
        p="sm"
        radius="md"
        className="board-column"
        data-over={dragId !== null && over?.status === status && canDrop(status)}
        bg="var(--mantine-color-default-hover)"
        style={
          status === 'needs-me' && column.length > 0
            ? { borderTop: '3px solid var(--mantine-color-orange-5)' }
            : undefined
        }
        onDragOver={(event: DragEvent) => {
          if (!dragId || !canDrop(status)) return;
          event.preventDefault();
          // Cards stop their own dragover, so this is the gap or the space below them: the bottom.
          if (over?.status !== status || over.beforeId !== undefined) setOver({ status });
        }}
        onDragLeave={(event: DragEvent) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null);
        }}
        onDrop={(event: DragEvent) => {
          event.preventDefault();
          drop(status);
        }}
      >
        <div className="board-column-content">
          <Group justify="space-between" mb="sm" wrap="nowrap">
            <Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
              <Badge color={STATUS_COLOR[status]} variant="light">
                {STATUS_LABEL[status]}
              </Badge>
              <Text size="sm" c="dimmed">
                {column.length}
              </Text>
            </Group>
            <Text size="xs" c="dimmed" ta="right" className="wrap-anywhere">
              {HINT[status]}
            </Text>
          </Group>
          {status === 'needs-me' && column.some(canMoveMergedToDone) && (
            <Button
              size="compact-xs"
              variant="light"
              color="grape"
              mb="xs"
              leftSection={<IconGitMerge size={14} />}
              loading={done.isPending}
              onClick={() => void moveMergedToDone()}
            >
              Move merged to Done ({column.filter(canMoveMergedToDone).length})
            </Button>
          )}
          <ScrollArea.Autosize mah={scrollMaxHeight(status, waitingShown)} offsetScrollbars>
            <Stack gap="xs" mih={60}>
              {column.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  draggable={canDrag(task)}
                  dragging={dragId === task.id}
                  hold={heldTask(task, machines.data ?? [], now)}
                  {...(canPolish(task) ? { onPolish: () => polish.polish(task) } : {})}
                  onIconChange={(icon) => configure.mutate({ task, icon })}
                  onLabelsChange={(labels) => configure.mutate({ task, labels })}
                  labelSuggestions={suggestions}
                  polishDisabled={
                    polish.isPending || (tasks.data ?? []).some((child) => isOpenPolishOf(child, task.id))
                  }
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move';
                    setDragId(task.id);
                  }}
                  onDragEnd={() => {
                    setDragId(null);
                    setOver(null);
                  }}
                  onDragOver={(event) => {
                    if (!dragId || !canDrop(status)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    if (isRecentFirst(status)) {
                      if (over?.status !== status) setOver({ status });
                      return;
                    }
                    const rect = event.currentTarget.getBoundingClientRect();
                    const ids = column.map((t) => t.id);
                    const beforeId = beforeIdOver(ids, dragId, task.id, event.clientY < rect.top + rect.height / 2);
                    if (over?.status !== status || over.beforeId !== beforeId) setOver({ status, beforeId });
                  }}
                />
              ))}
              {column.length === 0 && tasks.data !== undefined && (
                <Text size="sm" c="dimmed" ta="center" py="lg">
                  {status === 'needs-me' ? 'Nothing waiting for you' : 'Empty'}
                </Text>
              )}
            </Stack>
          </ScrollArea.Autosize>
        </div>
      </Paper>
    );
  };

  return (
    <Stack gap="md">
      <IncompatibleMachinesBanner />
      <QueryStatus query={tasks} what="the board" />
      {only !== undefined ? (
        <Box maw={640} w="100%" mx="auto">
          {renderColumn(only)}
        </Box>
      ) : (
        <div className="board">
          {CELLS.map((cell) => {
            const statuses = cell.filter((status) => status !== 'waiting' || waitingShown);
            return (
              <div
                key={cell.join()}
                className="board-cell"
                data-collapsible={statuses.length === 1 && COLLAPSIBLE.has(statuses[0]!)}
                data-status={statuses.join(' ')}
              >
                {statuses.map((status) => (
                  <Fragment key={status}>{renderColumn(status)}</Fragment>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </Stack>
  );
}

export const BoardPage = () => <BoardColumns />;

/** Backlog is hidden from the board on a phone, so it gets a page of its own. */
export const BacklogPage = () => <BoardColumns only="backlog" />;
