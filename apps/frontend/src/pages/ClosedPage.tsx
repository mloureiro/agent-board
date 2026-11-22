import { Anchor, Badge, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { QueryStatus } from '../components/QueryStatus';
import { usePageTitle } from '../components/usePageTitle';
import { STATUS_COLOR, STATUS_LABEL } from '../lib/status';
import { ago } from '../lib/time';
import { useTRPC } from '../lib/trpc';

export function ClosedPage() {
  usePageTitle('Closed');
  const trpc = useTRPC();
  const tasks = useQuery(trpc.tasks.list.queryOptions({ closed: true }));
  const sorted = [...(tasks.data ?? [])].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return (
    <Stack maw={900} mx="auto">
      <Title order={3}>Closed tasks</Title>
      <Text size="sm" c="dimmed">
        Out of the workflow: workers ignore them, and a PR whose review task is closed never gets another one.
      </Text>
      <QueryStatus query={tasks} what="closed tasks" />
      <Paper withBorder>
        {sorted.length === 0 && tasks.data !== undefined && (
          <Text size="sm" c="dimmed" p="md">
            Nothing closed.
          </Text>
        )}
        {sorted.map((task, index) => (
          <Group
            key={task.id}
            justify="space-between"
            wrap="nowrap"
            p="sm"
            style={{ borderTop: index ? '1px solid var(--mantine-color-default-border)' : undefined }}
          >
            <Anchor component={Link} to={`/t/${task.id}`} size="sm" className="wrap-anywhere">
              {task.title}
            </Anchor>
            <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
              <Badge size="sm" variant="light" color={STATUS_COLOR[task.status]}>
                {STATUS_LABEL[task.status]}
              </Badge>
              <Text size="xs" c="dimmed">
                {ago(task.updatedAt)}
              </Text>
            </Group>
          </Group>
        ))}
      </Paper>
    </Stack>
  );
}
