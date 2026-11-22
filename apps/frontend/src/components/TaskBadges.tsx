import { Badge, Group } from '@mantine/core';
import {
  IconArrowsExchange,
  IconCircleCheck,
  IconClock,
  IconDeviceDesktop,
  IconEye,
  IconGauge,
  IconHourglass,
  IconMessageQuestion,
  IconPlayerPause,
  IconPlayerStop,
  IconPlayerTrackNext,
  IconRepeat,
  IconRoute,
  IconUsers,
  IconSparkles,
  IconTag,
} from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { startsIn, wakesIn } from '../lib/startsIn';
import { isStopping } from '../lib/stopping';
import { clock, stamp } from '../lib/time';
import { watchBadgeText } from '../lib/watches';
import type { BoardTask } from '../lib/trpc';
import { describeHolding } from '../lib/usageHold';
import type { TaskHold } from '../lib/usageHold';
import { useNow } from '../lib/useNow';
import { PriorityBadge } from './PriorityPicker';

/**
 * What sets a task apart at a glance: its priority (unless normal), an open question, a proposal, a pending
 * resume, a start time still ahead, the end of a wait, a repeating schedule, a wait for a free slot of it, the lane it asks for, where it runs, a hold for usage, and whether its agent may mark it done.
 */
export function TaskBadges({
  task,
  withLabels = true,
  withPriority = true,
  hold,
  children,
}: {
  task: BoardTask;
  withLabels?: boolean;
  withPriority?: boolean;
  /** Why the task has not started for usage (`heldTask`); absent when it is not held. */
  hold?: TaskHold | undefined;
  children?: ReactNode;
}) {
  const now = useNow(30_000);
  const waiting = task.status === 'todo' && task.notBefore !== null ? startsIn(task.notBefore, now) : undefined;
  const wakes = task.status === 'waiting' ? wakesIn(task.wakeAt, task.waitCheck, now) : undefined;
  const watching = watchBadgeText(task);
  return (
    <Group gap={4}>
      {withPriority && task.priority !== 'normal' && <PriorityBadge priority={task.priority} />}
      {task.openQuestion && (
        <Badge size="sm" color="orange" variant="filled" leftSection={<IconMessageQuestion size={12} />}>
          Question
        </Badge>
      )}
      {task.autoDone && (
        <Badge
          size="sm"
          color="green"
          variant="light"
          tt="none"
          leftSection={<IconCircleCheck size={12} />}
          title="Its agent may move it to Done when it judges every acceptance criterion met"
        >
          Auto-done
        </Badge>
      )}
      {task.createdBy === 'agent' && (
        <Badge size="sm" color="grape" variant="light" leftSection={<IconSparkles size={12} />}>
          Proposed
        </Badge>
      )}
      {waiting !== undefined && task.notBefore !== null && (
        <Badge
          size="sm"
          color="teal"
          variant="light"
          tt="none"
          leftSection={<IconClock size={12} />}
          title={stamp(task.notBefore)}
        >
          {waiting}
        </Badge>
      )}
      {watching !== undefined && (
        <Badge
          size="sm"
          color="cyan"
          variant="light"
          tt="none"
          maw="100%"
          leftSection={<IconEye size={12} />}
          title={[
            ...(task.watches ?? []).map(({ name, label, status }) => `${name}: ${label} · ${status}`),
            wakes === undefined || task.wakeAt === null ? undefined : `${wakes} (${stamp(task.wakeAt)})`,
          ]
            .filter((line) => line !== undefined)
            .join('\n')}
        >
          {watching}
        </Badge>
      )}
      {wakes !== undefined && task.wakeAt !== null && !(watching !== undefined && task.waitCheck) && (
        <Badge
          size="sm"
          color="cyan"
          variant="light"
          tt="none"
          leftSection={<IconHourglass size={12} />}
          title={
            task.waitCheck
              ? `Wakes when its check on ${task.machine ?? 'its machine'} passes, at the latest ${stamp(task.wakeAt)}`
              : `Wakes ${stamp(task.wakeAt)}`
          }
        >
          {wakes}
        </Badge>
      )}
      {hold !== undefined && (
        <Badge
          size="sm"
          color="yellow"
          variant="light"
          tt="none"
          leftSection={<IconGauge size={12} />}
          title={hold.machines.map((machine) => describeHolding(machine, now)).join('\n')}
        >
          Held until {clock(hold.until, now)}
        </Badge>
      )}
      {task.status === 'todo' && task.held === true && (
        <Badge
          size="sm"
          color="yellow"
          variant="light"
          tt="none"
          leftSection={<IconUsers size={12} />}
          title="Its schedule runs at its limit of cards at once; this card starts when one of them finishes or leaves Running and Waiting"
        >
          Waits for a slot
        </Badge>
      )}
      {task.scheduleId !== null && (
        <Badge
          size="sm"
          color="cyan"
          variant="light"
          leftSection={<IconRepeat size={12} />}
          title="Made by a repeating schedule"
        >
          Repeat
        </Badge>
      )}
      {task.status === 'todo' && task.paused && (
        <Badge size="sm" color="yellow" variant="light" leftSection={<IconPlayerPause size={12} />}>
          Paused
        </Badge>
      )}
      {task.status === 'todo' && task.woken && !task.paused && (
        <Badge size="sm" color="cyan" variant="light" leftSection={<IconPlayerTrackNext size={12} />}>
          Woken
        </Badge>
      )}
      {task.status === 'todo' && task.next === 'resume' && !task.paused && !task.woken && (
        <Badge size="sm" color="indigo" variant="light" leftSection={<IconPlayerTrackNext size={12} />}>
          Resume
        </Badge>
      )}
      {(task.status === 'todo' || task.status === 'backlog') && task.requestedLane !== null && (
        <Badge
          size="sm"
          color="teal"
          variant="light"
          tt="none"
          leftSection={<IconRoute size={12} />}
          title="The lane it asks for; a machine without that lane runs it in its default lane"
        >
          {task.requestedLane}
        </Badge>
      )}
      {task.status === 'running' && task.machine && (
        <Badge size="sm" color="blue" variant="light" tt="none" leftSection={<IconDeviceDesktop size={12} />}>
          {task.lane ? `${task.machine} · ${task.lane}` : task.machine}
        </Badge>
      )}
      {isStopping(task) && (
        <Badge size="sm" color="red" variant="light" leftSection={<IconPlayerStop size={12} />}>
          Stopping…
        </Badge>
      )}
      {task.status === 'running' && task.borrowed && (
        <Badge
          size="sm"
          color="grape"
          variant="light"
          tt="none"
          leftSection={<IconArrowsExchange size={12} />}
          title="Running in another lane's slot; it may be paused when that lane gets work of its own"
        >
          borrowed
        </Badge>
      )}
      {withLabels &&
        task.skillLabels.map((label) => (
          <Badge key={`skill:${label}`} size="sm" variant="default" tt="none">
            {label}
          </Badge>
        ))}
      {withLabels &&
        task.labels.map((label) => (
          <Badge
            key={`label:${label}`}
            size="sm"
            variant="light"
            color="indigo"
            tt="none"
            leftSection={<IconTag size={10} />}
            aria-label={`Label ${label}`}
          >
            {label}
          </Badge>
        ))}
      {children}
    </Group>
  );
}
