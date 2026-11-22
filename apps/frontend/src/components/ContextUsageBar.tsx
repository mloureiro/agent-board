import { Box, Progress, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { describeContext } from '../lib/contextUsage';
import { ago } from '../lib/time';
import { useTRPC } from '../lib/trpc';

const CONTEXT_LIVE_MS = 15_000;

export function ContextUsageBar({ taskId, live }: { taskId: string; live: boolean }) {
  const trpc = useTRPC();
  const { data, refetch } = useQuery({
    ...trpc.transcript.context.queryOptions({ id: taskId }),
    refetchInterval: live ? CONTEXT_LIVE_MS : false,
  });
  const wasLive = useRef(live);
  useEffect(() => {
    if (wasLive.current && !live) void refetch();
    wasLive.current = live;
  }, [live, refetch]);

  if (data === undefined || data === null) return null;
  if (data === 'unreadable')
    return (
      <Stack gap={4}>
        <Progress size="sm" value={0} />
        <Text size="xs" c="dimmed">
          context reading unreadable
        </Text>
      </Stack>
    );
  const { percent, label, marker } = describeContext(data);
  return (
    <Stack gap={4}>
      <Box pos="relative">
        <Progress size="sm" value={percent ?? 0} aria-label="Context window used" />
        {marker !== null && (
          <Box
            pos="absolute"
            top={-2}
            bottom={-2}
            w={2}
            bg="dark.3"
            style={{ left: `${marker}%` }}
            title={`Auto-compact at ${marker}%`}
          />
        )}
      </Box>
      <Text size="xs" c="dimmed" title={`${data.model} · ${ago(data.at)}`}>
        {label}
      </Text>
    </Stack>
  );
}
