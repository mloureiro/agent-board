import { prsOf, type UnreadableField } from '@agent-board/shared';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Breadcrumbs,
  Button,
  Center,
  Container,
  Group,
  Loader,
  Paper,
  Spoiler,
  Stack,
  Text,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { IconCornerDownRight, IconGitFork, IconLockOff, IconTerminal2, IconX } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ActionPanel } from '../components/ActionPanel';
import { ContextUsageBar } from '../components/ContextUsageBar';
import { ForkModal } from '../components/ForkModal';
import { EditTaskPrompt } from '../components/EditPrompt';
import { WatchList } from '../components/WatchList';
import { Markdown } from '../components/Markdown';
import { PriorityPicker } from '../components/PriorityPicker';
import { PrStateIcon } from '../components/PrStateIcon';
import { PolishItem } from '../components/PolishItem';
import { TaskBadges } from '../components/TaskBadges';
import {
  AutoDoneSetting,
  EffortPicker,
  LanePicker,
  ModelPicker,
  TaskIconPicker,
  TaskLabelsPicker,
  TitleSetting,
  WorkdirSetting,
} from '../components/TaskSettings';
import { ThreadItem } from '../components/ThreadItem';
import { TranscriptDrawer } from '../components/TranscriptDrawer';
import { openQuestionOf } from '../lib/answers';
import { skillsFor } from '../lib/catalog';
import { canFork } from '@agent-board/shared/ui';
import { STATUS_COLOR, STATUS_LABEL } from '../lib/status';
import { ago, stamp } from '../lib/time';
import { errorMessage, POLL_MS, useTRPC } from '../lib/trpc';
import { heldTask } from '../lib/usageHold';
import { useNow } from '../lib/useNow';
import { unlistedMachine } from '../lib/workingDirectories';

const PANEL_HEIGHT_VAR = '--task-panel-height';

function trackPanelHeight(element: HTMLDivElement) {
  const root = document.documentElement;
  const observer = new ResizeObserver(() => root.style.setProperty(PANEL_HEIGHT_VAR, `${element.offsetHeight}px`));
  observer.observe(element);
  return () => {
    observer.disconnect();
    root.style.removeProperty(PANEL_HEIGHT_VAR);
  };
}

const UNREADABLE_LABEL = (field: UnreadableField): string =>
  field === 'input' ? 'prompt' : field === 'workdir' ? 'directory' : field;

/** Why a card in Todo is not started although it is due: its schedule has all the slots it allows in use. */
function HeldNotice({ scheduleId }: { scheduleId: string }) {
  const trpc = useTRPC();
  const schedules = useQuery({ ...trpc.schedules.list.queryOptions(), refetchInterval: POLL_MS });
  const limit = schedules.data?.find(({ id }) => id === scheduleId)?.maxConcurrent ?? null;
  return (
    <Text size="sm" c="dimmed">
      Waits for a free slot: its schedule runs{limit === null ? ' only a limited number of cards' : ` at most ${limit}`}{' '}
      at once. It starts when one of them finishes or leaves Running and Waiting.
    </Text>
  );
}

export function TaskPage() {
  const { id = '' } = useParams();
  // The route element stays mounted from one /t/:id to the next. Keyed by the id, nothing of task A (the reply
  // draft, pending buttons, the transcript's selected run) shows up on task B, even when B comes from the cache.
  return <TaskView key={id} id={id} />;
}

function TaskView({ id }: { id: string }) {
  const trpc = useTRPC();
  const query = useQuery({ ...trpc.tasks.get.queryOptions({ id }), refetchInterval: POLL_MS });
  const setPriority = useMutation(trpc.tasks.setPriority.mutationOptions());
  const removePr = useMutation(trpc.tasks.removePr.mutationOptions());
  const stopWatch = useMutation(trpc.tasks.stopWatch.mutationOptions());
  const machines = useQuery({ ...trpc.machines.list.queryOptions(), refetchInterval: POLL_MS });
  const now = useNow(30_000);
  const catalogs = useQuery(trpc.machines.catalogs.queryOptions());
  const [search, setSearch] = useSearchParams();
  const transcriptOpen = search.get('transcript') !== null;
  const setTranscriptOpen = (open: boolean) => setSearch(open ? { transcript: '1' } : {}, { replace: true });
  const [forking, setForking] = useState(false);
  const noteCount = query.data?.thread.length ?? 0;

  // Land on the newest note and the action panel; follow new notes as they arrive.
  useEffect(() => {
    if (noteCount > 0) document.documentElement.scrollTo({ top: document.documentElement.scrollHeight });
  }, [noteCount]);

  if (query.isLoading) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }
  if (!query.data) {
    return (
      <Center py="xl">
        <Text c="red">{errorMessage(query.error)}</Text>
      </Center>
    );
  }

  const { task, thread, followUps, parent } = query.data;
  const openQuestion = openQuestionOf(task, thread);
  const unlisted = unlistedMachine(task, machines.data ?? []);
  const skills = skillsFor(catalogs.data ?? [], task);
  const prs = prsOf(task);

  return (
    <Container size="md" px={0}>
      <Stack gap="md" className="task-page">
        <Breadcrumbs styles={{ root: { flexWrap: 'nowrap', minWidth: 0 }, separator: { flexShrink: 0 } }}>
          <Anchor component={Link} to="/" size="sm">
            Board
          </Anchor>
          {parent && (
            <Anchor component={Link} to={`/t/${parent.id}`} size="sm" truncate>
              {parent.title}
            </Anchor>
          )}
          <Text size="sm" c="dimmed" style={{ flexShrink: 0 }}>
            {task.id}
          </Text>
        </Breadcrumbs>

        <Stack gap="xs">
          <Group gap="xs" wrap="nowrap" align="flex-start">
            <TaskIconPicker task={task} size={24} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <TitleSetting task={task} />
            </div>
          </Group>
          <Group gap="xs">
            <Badge color={STATUS_COLOR[task.status]}>{task.closed ? 'Closed' : STATUS_LABEL[task.status]}</Badge>
            <PriorityPicker
              value={task.priority}
              onChange={(priority) => setPriority.mutate({ id: task.id, priority })}
            />
            <ModelPicker task={task} />
            <EffortPicker task={task} />
            <LanePicker task={task} />
            {task.agent ? (
              <Badge variant="default" tt="none" size="sm" title="The agent of the machine's config.json it runs as">
                Agent: {task.agent}
              </Badge>
            ) : null}
            <TaskBadges task={task} withPriority={false} hold={heldTask(task, machines.data ?? [], now)}>
              <TaskLabelsPicker task={task} />
            </TaskBadges>
            <Text size="xs" c="dimmed" title={stamp(task.createdAt)}>
              created by {task.createdBy} {ago(task.createdAt)}
            </Text>
          </Group>
          {task.forkOf !== undefined && (
            <Text size="sm" c="dimmed" data-testid="forked-from">
              Forked from{' '}
              <Anchor component={Link} to={`/t/${task.forkOf}`} size="sm">
                {parent?.id === task.forkOf ? parent.title : task.forkOf}
              </Anchor>
            </Text>
          )}
          <WorkdirSetting task={task} unlisted={unlisted} />
          <AutoDoneSetting task={task} />
          <ContextUsageBar taskId={task.id} live={task.status === 'running'} />
          <Group gap="xs">
            <Button
              variant="default"
              size="xs"
              leftSection={<IconTerminal2 size={14} />}
              onClick={() => setTranscriptOpen(true)}
            >
              Transcript
            </Button>
            {canFork(task) && (
              <Button
                variant="default"
                size="xs"
                leftSection={<IconGitFork size={14} />}
                title="Side work with the context of this task: a new task that continues a copy of its session"
                onClick={() => setForking(true)}
              >
                Fork
              </Button>
            )}
          </Group>
          {canFork(task) && (
            <ForkModal key={task.id} opened={forking} onClose={() => setForking(false)} parent={task} />
          )}
          {prs.length > 0 && (
            <Group gap="xs">
              {prs.map(({ url, state, id: prId, prompt }) => {
                const name = url.replace('https://github.com/', '');
                const confirmRemove = (rowId: string) =>
                  modals.openConfirmModal({
                    title: `Remove ${name}?`,
                    children: (
                      <Text size="sm">
                        It comes off this task and no longer counts for Move merged to Done. The agent can report it
                        again with board pr.
                      </Text>
                    ),
                    labels: { confirm: 'Remove', cancel: 'Cancel' },
                    confirmProps: { color: 'red' },
                    onConfirm: () => removePr.mutate({ id: task.id, prId: rowId }),
                  });
                return (
                  <Group key={url} gap={4} wrap="nowrap" className="truncate-flex">
                    <Button
                      component="a"
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      variant="default"
                      size="xs"
                      className="truncate-flex"
                      leftSection={<PrStateIcon state={state} size={14} />}
                    >
                      {name}
                    </Button>
                    {prId !== undefined && !prompt && (
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        size="sm"
                        aria-label={`Remove ${name}`}
                        title="Take this pull request off the task"
                        loading={removePr.isPending}
                        onClick={() => confirmRemove(prId)}
                      >
                        <IconX size={14} />
                      </ActionIcon>
                    )}
                  </Group>
                );
              })}
            </Group>
          )}
        </Stack>

        {task.status === 'todo' && task.held === true && task.scheduleId !== null && (
          <HeldNotice scheduleId={task.scheduleId} />
        )}

        {task.invalid.length > 0 && (
          <Alert
            color="orange"
            variant="light"
            icon={<IconLockOff size={18} />}
            title="The board sent unexpected values"
          >
            <Text size="sm">
              The board sent {task.invalid.join(', ')} for this task in a form it does not use, so neutral values are
              shown instead. Treat this task with care.
            </Text>
          </Alert>
        )}

        {task.unreadable.length > 0 && (
          <Alert
            color="orange"
            variant="light"
            icon={<IconLockOff size={18} />}
            title="Part of this task cannot be read"
          >
            <Text size="sm">
              This browser could not decrypt the task&apos;s {task.unreadable.map(UNREADABLE_LABEL).join(', ')}. It was
              not written with your key, or it is damaged, so it is not shown.
              {task.unreadable.some((field) => field !== 'watches') && ' Workers will not run the task.'}
            </Text>
          </Alert>
        )}

        {task.input && (
          <Paper withBorder p="sm">
            <Group justify="space-between" mb={4} wrap="nowrap">
              <Text size="xs" c="dimmed" fw={600} tt="uppercase">
                Prompt
              </Text>
              <EditTaskPrompt task={task} skills={skills} />
            </Group>
            {task.scheduleId !== null && (
              <Text size="xs" c="dimmed" mb={4}>
                This card is the next run of a schedule.{' '}
                <Anchor component={Link} to="/schedules" size="xs">
                  Edit the prompt on the Schedules page
                </Anchor>
                ; the change applies to this card too while it has not started.
              </Text>
            )}
            <Spoiler maxHeight={180} showLabel="Show all" hideLabel="Show less">
              <Markdown>{task.input}</Markdown>
            </Spoiler>
          </Paper>
        )}

        {((task.watches?.length ?? 0) > 0 || task.watchStops.length > 0) && (
          <WatchList
            watches={task.watches ?? []}
            pendingEvents={task.watchEvents}
            stopping={task.watchStops}
            onStop={(watchId) => stopWatch.mutate({ id: task.id, watchId })}
          />
        )}

        {followUps.length > 0 && (
          <Paper withBorder p="sm">
            <Text size="xs" c="dimmed" fw={600} mb={4} tt="uppercase">
              Follow-ups
            </Text>
            <Stack gap={4}>
              {followUps.map((f) => (
                <Group key={f.id} gap="xs" wrap="nowrap" align="flex-start">
                  <IconCornerDownRight size={14} style={{ flexShrink: 0, marginTop: 4 }} />
                  <Anchor component={Link} to={`/t/${f.id}`} size="sm" className="wrap-anywhere">
                    {f.title}
                  </Anchor>
                  <Badge size="xs" color={STATUS_COLOR[f.status]} variant="light">
                    {STATUS_LABEL[f.status]}
                  </Badge>
                  <TaskBadges task={f} withLabels={false} hold={heldTask(f, machines.data ?? [], now)} />
                </Group>
              ))}
            </Stack>
          </Paper>
        )}

        <Stack gap="sm">
          {thread.length === 0 && (
            <Text size="sm" c="dimmed" ta="center" py="md">
              No activity yet.
            </Text>
          )}
          {thread.map((note, index) =>
            note.kind === 'polish' && !note.unreadable ? (
              <PolishItem key={index} note={note} task={task} parent={parent} />
            ) : (
              <ThreadItem key={index} note={note} thread={thread} openQuestionId={openQuestion?.id} />
            ),
          )}
        </Stack>

        <TranscriptDrawer
          taskId={task.id}
          opened={transcriptOpen}
          onClose={() => setTranscriptOpen(false)}
          live={task.status === 'running'}
        />

        <div className="task-panel" ref={trackPanelHeight}>
          <div className="task-panel-scroll">
            <ActionPanel task={task} thread={thread} followUps={followUps} skills={skills} />
          </div>
        </div>
      </Stack>
    </Container>
  );
}
