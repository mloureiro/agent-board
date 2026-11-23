import { ActionIcon, Button, Group, Modal, Select, Stack, Switch, Text, TextInput, Title } from '@mantine/core';
import { IconPencil } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { titleSlot } from '../lib/drafts';
import { useDraft } from '../lib/draftsContext';
import { DEFAULT_EFFORT, EFFORT_OPTIONS, effortFromOption } from '../lib/effort';
import { DEFAULT_LANE, laneFromOption } from '../lib/lane';
import { DEFAULT_MODEL, modelFromOption } from '../lib/model';
import { errorMessage, useTRPC, type BoardTask } from '../lib/trpc';
import { isCurrentPlace } from '../lib/workingDirectories';
import { confirmPlace } from './confirmPlace';
import { DirectorySelect } from './DirectorySelect';
import { EmojiPicker } from './EmojiPicker';
import { LabelsEditor } from './LabelsEditor';
import { useDirectoryChoices } from './useDirectoryChoices';
import { useLaneOptions } from './useLaneOptions';
import { useModelOptions } from './useModelOptions';

const SCHEDULE_HINT =
  'This card belongs to a schedule: the change applies to it only, the next occurrence takes its settings from the schedule.';

/** The task's title, renamed in place in every status: Enter saves, Escape cancels. A schedule's card takes its title from the schedule. */
export function TitleSetting({ task }: { task: BoardTask }) {
  const trpc = useTRPC();
  const configure = useMutation(trpc.tasks.configure.mutationOptions());
  const [draft, setDraft, clearDraft] = useDraft(titleSlot(task));
  const unreadable = task.unreadable.includes('title');
  const cancel = () => {
    clearDraft();
    configure.reset();
  };
  if (draft === null)
    return (
      <Group gap={4} wrap="nowrap" align="flex-start">
        <Title order={3} className="wrap-anywhere">
          {task.title}
        </Title>
        {task.scheduleId === null && (
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            mt={4}
            aria-label="Rename the task"
            title="Rename the task"
            onClick={() => setDraft(unreadable ? '' : task.title)}
            style={{ flexShrink: 0 }}
          >
            <IconPencil size={16} />
          </ActionIcon>
        )}
      </Group>
    );
  const title = draft.trim();
  const unchanged = title === '' || (!unreadable && title === task.title);
  const save = () => {
    if (!unchanged && !configure.isPending) configure.mutate({ task, title }, { onSuccess: () => setDraft(null) });
  };
  return (
    <Stack gap={4}>
      <Group gap="xs" wrap="nowrap">
        <TextInput
          aria-label="Title"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') save();
            if (event.key === 'Escape') cancel();
          }}
          autoFocus
          style={{ flex: 1 }}
        />
        <Button size="xs" onClick={save} disabled={unchanged} loading={configure.isPending}>
          Save
        </Button>
        <Button size="xs" variant="default" onClick={cancel}>
          Cancel
        </Button>
      </Group>
      {configure.error !== null && (
        <Text size="xs" c="red">
          {errorMessage(configure.error)}
        </Text>
      )}
    </Stack>
  );
}

/** A change applies from the next run on, in every status. */
export function ModelPicker({ task }: { task: BoardTask }) {
  const trpc = useTRPC();
  const configure = useMutation(trpc.tasks.configure.mutationOptions());
  const { options } = useModelOptions(task.machine, task.model);
  return (
    <Select
      aria-label="Model"
      title={`The Claude model its runs use, from the next run on${task.scheduleId === null ? '' : `. ${SCHEDULE_HINT}`}`}
      size="xs"
      w={130}
      allowDeselect={false}
      data={options}
      value={task.model ?? DEFAULT_MODEL}
      onChange={(value) => value !== null && configure.mutate({ task, model: modelFromOption(value) })}
      disabled={configure.isPending}
    />
  );
}

/** A change applies from the next run on, in every status. */
export function EffortPicker({ task }: { task: BoardTask }) {
  const trpc = useTRPC();
  const configure = useMutation(trpc.tasks.configure.mutationOptions());
  return (
    <Select
      aria-label="Effort"
      title={`How hard claude thinks in its runs, from the next run on${task.scheduleId === null ? '' : `. ${SCHEDULE_HINT}`}`}
      size="xs"
      w={110}
      allowDeselect={false}
      data={EFFORT_OPTIONS}
      value={task.effort ?? DEFAULT_EFFORT}
      onChange={(value) => value !== null && configure.mutate({ task, effort: effortFromOption(value) })}
      disabled={configure.isPending}
    />
  );
}

/** The lane the task asks for, from its next start on; a running task keeps the lane it started in. */
export function LanePicker({ task }: { task: BoardTask }) {
  const trpc = useTRPC();
  const configure = useMutation(trpc.tasks.configure.mutationOptions());
  const lanes = useLaneOptions(task.machine, task.requestedLane);
  const running = task.status === 'running';
  return (
    <Select
      aria-label="Lane"
      title={
        running
          ? 'The task is running: it keeps its lane until its next start'
          : `The lane of the machine that runs it, from its next start on${task.scheduleId === null ? '' : `. ${SCHEDULE_HINT}`}`
      }
      size="xs"
      w={130}
      allowDeselect={false}
      data={lanes}
      value={task.requestedLane ?? DEFAULT_LANE}
      onChange={(value) => value !== null && configure.mutate({ task, lane: laneFromOption(value) })}
      disabled={running || configure.isPending}
    />
  );
}

export function TaskIconPicker({ task, size }: { task: BoardTask; size: number }) {
  const trpc = useTRPC();
  const configure = useMutation(trpc.tasks.configure.mutationOptions());
  return (
    <EmojiPicker
      value={task.icon ?? null}
      onChange={(icon) => configure.mutate({ task, icon })}
      disabled={configure.isPending}
      size={size}
    />
  );
}

export function TaskLabelsPicker({ task }: { task: BoardTask }) {
  const trpc = useTRPC();
  const configure = useMutation(trpc.tasks.configure.mutationOptions());
  return (
    <LabelsEditor
      value={task.labels}
      onChange={(labels) => configure.mutate({ task, labels })}
      disabled={configure.isPending}
    />
  );
}

/** Whether the agent may move the task to Done itself. A change takes effect at once, in every status. */
export function AutoDoneSetting({ task }: { task: BoardTask }) {
  const trpc = useTRPC();
  const configure = useMutation(trpc.tasks.configure.mutationOptions());
  return (
    <Switch
      size="xs"
      label="Agent may mark it done"
      description={`When it judges every acceptance criterion met and nothing is left for you, the agent moves the task to Done instead of Needs me.${task.scheduleId === null ? '' : ` ${SCHEDULE_HINT}`}`}
      checked={task.autoDone}
      onChange={(event) => configure.mutate({ task, autoDone: event.currentTarget.checked })}
      disabled={configure.isPending}
    />
  );
}

function WorkdirModal({ task, onClose }: { task: BoardTask; onClose: () => void }) {
  const trpc = useTRPC();
  const configure = useMutation(trpc.tasks.configure.mutationOptions());
  const directories = useDirectoryChoices();
  // Untouched is not "no directory": saving then would drop a directory the lists do not offer.
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const current = directories.choices.find(({ machine, path }) => machine === task.machine && path === task.workdir);
  const shown = picked === undefined ? (current?.value ?? null) : picked;
  const target = directories.choices.find(({ value }) => value === picked);
  // A pick the lists no longer offer (a refetch dropped it) is not "no directory": only the button chooses that.
  const unchanged = picked === undefined || (picked !== null && target === undefined) || isCurrentPlace(task, target);
  const currentPlace =
    task.workdir === null ? undefined : `${task.machine === null ? '' : `${task.machine}:`}${task.workdir}`;
  const save = () => {
    const place = target === undefined ? null : { machine: target.machine, workdir: target.path };
    const move = () => configure.mutate({ task, place }, { onSuccess: onClose });
    if (task.sessionId === null) move();
    else
      confirmPlace(
        { to: target === undefined ? 'in a default directory' : `in ${target.machine}:${target.path}` },
        move,
      );
  };
  return (
    <Stack>
      <DirectorySelect
        label="Working directory"
        directories={directories}
        value={shown}
        onChange={setPicked}
        placeholder={picked === undefined ? currentPlace : undefined}
      />
      {task.scheduleId !== null && (
        <Text size="xs" c="dimmed">
          {SCHEDULE_HINT}
        </Text>
      )}
      <Group justify="space-between" wrap="wrap">
        <Button variant="subtle" size="xs" onClick={() => setPicked(null)}>
          No directory
        </Button>
        <Group gap="xs">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={unchanged} loading={configure.isPending}>
            Save
          </Button>
        </Group>
      </Group>
    </Stack>
  );
}

/** Where the task runs, as the machine and directory it is pinned to, with a way to change it while it is not running. */
export function WorkdirSetting({ task, unlisted }: { task: BoardTask; unlisted: string | undefined }) {
  const [opened, setOpened] = useState(false);
  const locked = task.status === 'running' || task.status === 'waiting';
  const where = task.unreadable.includes('workdir')
    ? 'Directory cannot be read'
    : task.workdir === null
      ? 'No directory: runs in the default directory of whichever machine takes it'
      : `${task.machine ? `${task.machine}:` : ''}${task.workdir}${unlisted === undefined ? '' : ` · not listed on ${unlisted}`}`;
  return (
    <Group gap={4} wrap="nowrap" align="flex-start">
      <Text
        size="xs"
        c="dimmed"
        ff="monospace"
        className="wrap-anywhere"
        title="Where the task's session last worked; a resume starts here"
      >
        {where}
        {locked && ' · stop the task to change it'}
      </Text>
      <ActionIcon
        variant="subtle"
        color="gray"
        size="xs"
        aria-label="Change the working directory"
        title={locked ? `The task is ${task.status}: stop it to change the directory` : 'Change the working directory'}
        disabled={locked}
        onClick={() => setOpened(true)}
        style={{ flexShrink: 0 }}
      >
        <IconPencil size={14} />
      </ActionIcon>
      <Modal opened={opened} onClose={() => setOpened(false)} title="Working directory">
        <WorkdirModal task={task} onClose={() => setOpened(false)} />
      </Modal>
    </Group>
  );
}
