import { Stack, Text } from '@mantine/core';
import { ago, clock } from '../lib/time';
import type { Machine } from '@agent-board/shared/ui';
import {
  activeHold,
  describeHoldWindow,
  describeLimits,
  describeReadings,
  describeResets,
  isFresh,
} from '../lib/usageHold';

/** What a machine reported of its subscription usage: the readings, its limits and, while it holds tasks back, why and until when. */
export function MachineUsageLines({ machine, now }: { machine: Machine; now: number }) {
  if (machine.usageUnreadable)
    return (
      <Text size="xs" c="dimmed">
        usage status unreadable
      </Text>
    );
  const { usage } = machine;
  if (usage === null) return null;
  const readings = describeReadings(machine, now);
  const limits = describeLimits(machine);
  const hold = activeHold(machine, now);
  const asOf = !isFresh(machine, now) && machine.usageUpdatedAt ? ` (as of ${ago(machine.usageUpdatedAt)})` : '';
  return (
    <Stack gap={0}>
      {readings !== '' && (
        <Text size="xs" c="dimmed" title={describeResets(machine, now)}>
          Usage {readings}
        </Text>
      )}
      {limits !== '' && (
        <Text size="xs" c="dimmed">
          Limits {limits}
        </Text>
      )}
      {hold !== undefined && (
        <Text size="xs" c="yellow.8">
          Holding tasks below {hold.priority} until {clock(hold.until, now)}:{' '}
          {hold.windows.map(describeHoldWindow).join('; ')}
          {' · '}
          {usage.held.length === 1 ? '1 task held' : `${usage.held.length} tasks held`}
          {asOf}
        </Text>
      )}
    </Stack>
  );
}
