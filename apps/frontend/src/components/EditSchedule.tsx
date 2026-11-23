import { formatDuration, runsLeft } from '@agent-board/shared';
import { Alert, Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { skillsFor } from '../lib/catalog';
import { DEFAULT_LANE, laneFromOption } from '../lib/lane';
import { DEFAULT_EFFORT, effortFromOption } from '../lib/effort';
import { DEFAULT_MODEL, modelFromOption } from '../lib/model';
import { scheduleSlot } from '../lib/drafts';
import { useDraft } from '../lib/draftsContext';
import { parseDelay, parseRepeatRule } from '../lib/repeat';
import { localInputValue } from '../lib/time';
import { errorMessage, useTRPC, type Schedule } from '../lib/trpc';
import { DirectorySelect } from './DirectorySelect';
import { MarkdownEditor } from './MarkdownEditor';
import { RepeatFields, limitError, timesError } from './RepeatFields';
import {
  AgentField,
  AutoDoneField,
  EffortField,
  LaneField,
  ModelField,
  PriorityField,
  agentNameError,
} from './TaskFields';
import { useDirectoryChoices, type DirectoryChoicesState } from './useDirectoryChoices';
import { useLaneOptions } from './useLaneOptions';
import { useModelOptions } from './useModelOptions';

type PendingCard = 'updated' | 'started' | 'none' | 'removed' | 'created';

/** What saving a schedule tells the user about the card waiting on the board. */
export function pendingCardMessage(pending: PendingCard): string {
  switch (pending) {
    case 'updated':
      return 'The pending card was updated too.';
    case 'started':
      return 'The pending card has already started; the change applies from the next run.';
    case 'none':
      return 'The schedule has no pending card; its next run takes the change.';
    case 'removed':
      return 'The pending card was removed; the next one is made when a card of the schedule it runs after finishes.';
    case 'created':
      return 'A card now waits for the schedule’s next run.';
  }
}

const placeValue = (machine: string, path: string): string => JSON.stringify([machine, path]);

/** The listed directories, plus the schedule's own when no machine lists it, so it stays selected. */
function withCurrentPlace(directories: DirectoryChoicesState, schedule: Schedule): DirectoryChoicesState {
  const { machine, workdir } = schedule;
  if (machine === null || workdir === null) return directories;
  const value = placeValue(machine, workdir);
  if (directories.choices.some((choice) => choice.value === value)) return directories;
  return {
    ...directories,
    choices: [...directories.choices, { value, machine, path: workdir }],
    groups: [...directories.groups, { group: `${machine} · current`, items: [{ value, label: workdir }] }],
  };
}

function ruleLinesOf(schedule: Schedule): string[] {
  if (schedule.everyMs !== null) return [formatDuration(schedule.everyMs)];
  return schedule.cron === null ? [''] : [schedule.cron, ...(schedule.moreCrons ?? [])];
}

/** The schedules that, directly or through others, run after `id`: running after one of them would make a circle. */
function downstreamOf(id: string, all: readonly Schedule[]): Set<string> {
  const found = new Set<string>();
  const grow = (): void => {
    const size = found.size;
    for (const { id: candidate, after } of all)
      if (after !== null && (after.scheduleId === id || found.has(after.scheduleId))) found.add(candidate);
    if (found.size > size) grow();
  };
  grow();
  return found;
}

function EditScheduleForm({ schedule, onClose }: { schedule: Schedule; onClose: () => void }) {
  const trpc = useTRPC();
  const update = useMutation(trpc.schedules.update.mutationOptions());
  const schedules = useQuery(trpc.schedules.list.queryOptions()).data;
  const catalogs = useQuery(trpc.machines.catalogs.queryOptions());
  const directories = withCurrentPlace(useDirectoryChoices(), schedule);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const firstRun = localInputValue(schedule.anchorAt);
  const [{ title, input }, setText, clearText] = useDraft(scheduleSlot(schedule));
  const [directory, setDirectory] = useState<string | null>(
    schedule.machine !== null && schedule.workdir !== null ? placeValue(schedule.machine, schedule.workdir) : null,
  );
  const [agent, setAgent] = useState(schedule.agent ?? '');
  const [priority, setPriority] = useState(schedule.priority);
  const [model, setModel] = useState(schedule.model ?? DEFAULT_MODEL);
  const [effort, setEffort] = useState(schedule.effort ?? DEFAULT_EFFORT);
  const [lane, setLane] = useState(schedule.requestedLane ?? DEFAULT_LANE);
  const [autoDone, setAutoDone] = useState(schedule.autoDone);
  const [after, setAfter] = useState<string | null>(schedule.after?.scheduleId ?? null);
  const [delay, setDelay] = useState(
    schedule.after && schedule.after.delayMs > 0 ? formatDuration(schedule.after.delayMs) : '',
  );
  const [ruleLines, setRuleLines] = useState(() => ruleLinesOf(schedule));
  const [at, setAt] = useState(firstRun);
  const [times, setTimes] = useState<number | string>(runsLeft(schedule) ?? '');
  const [limit, setLimit] = useState<number | string>(schedule.maxConcurrent ?? '');
  const [saved, setSaved] = useState<PendingCard | undefined>(undefined);

  const place = directories.choices.find(({ value }) => value === directory);
  const skills = useMemo(
    () => skillsFor(catalogs.data ?? [], { machine: place?.machine, workdir: place?.path }),
    [catalogs.data, place?.machine, place?.path],
  );
  const models = useModelOptions(place?.machine, model);
  const lanes = useLaneOptions(place?.machine, lane);
  const parsedRule = parseRepeatRule(ruleLines.join('\n'), timezone);
  const ruleError =
    after === null && 'error' in parsedRule && ruleLines.some((line) => line.trim() !== '')
      ? parsedRule.error
      : undefined;
  const delayMs = parseDelay(delay);
  const delayError = after !== null && delayMs === undefined ? 'A duration such as 10m, 2h or 1d' : undefined;
  const atError = at !== '' && Number.isNaN(new Date(at).getTime()) ? 'Pick a date and time' : undefined;
  const repeat =
    after !== null
      ? delayMs === undefined
        ? undefined
        : { after: { scheduleId: after, delayMs } }
      : 'error' in parsedRule
        ? undefined
        : 'every' in parsedRule
          ? { everyMs: parsedRule.every }
          : parsedRule;
  const agentName = agent.trim();
  const ready =
    input.trim() !== '' &&
    agentNameError(agent) === undefined &&
    repeat !== undefined &&
    atError === undefined &&
    timesError(times) === undefined &&
    limitError(limit) === undefined;
  const upstreams = useMemo(() => {
    const everything = schedules ?? [];
    const downstream = downstreamOf(schedule.id, everything);
    return everything
      .filter(
        ({ id, ended }) => id !== schedule.id && !downstream.has(id) && (!ended || id === schedule.after?.scheduleId),
      )
      .map(({ id, title: name, unreadable }) => ({ value: id, label: unreadable.includes('title') ? id : name }));
  }, [schedules, schedule.id, schedule.after?.scheduleId]);

  const save = () => {
    if (!ready || repeat === undefined || update.isPending) return;
    update.mutate(
      {
        id: schedule.id,
        title,
        input,
        agent: agentName === '' ? null : agentName,
        place: place === undefined ? null : { machine: place.machine, workdir: place.path },
        priority,
        model: modelFromOption(model),
        effort: effortFromOption(effort),
        lane: laneFromOption(lane),
        autoDone,
        repeat,
        ...(after === null && at !== '' && at !== firstRun ? { at: new Date(at) } : {}),
        runsLeft: times === '' ? null : Number(times),
        until: times === '' && schedule.until !== null ? new Date(schedule.until) : null,
        maxConcurrent: limit === '' ? null : Number(limit),
        unreadable: schedule.unreadable,
      },
      {
        onSuccess: ({ pending }) => {
          clearText();
          setSaved(pending);
        },
      },
    );
  };

  if (saved !== undefined)
    return (
      <Stack>
        <Alert color="green" variant="light" title="Saved">
          <Text size="sm">{pendingCardMessage(saved)}</Text>
        </Alert>
        <Group justify="flex-end">
          <Button onClick={onClose}>Close</Button>
        </Group>
      </Stack>
    );
  return (
    <Stack>
      <MarkdownEditor
        label="Prompt"
        value={input}
        onChange={(next) => setText({ title, input: next })}
        minRows={8}
        onSubmit={save}
        autoFocus
        skills={skills}
      />
      <DirectorySelect label="Working directory" directories={directories} value={directory} onChange={setDirectory} />
      <AgentField value={agent} onChange={setAgent} />
      <TextInput
        label="Title"
        placeholder="Defaults to the prompt's first line"
        value={title}
        onChange={(event) => setText({ title: event.currentTarget.value, input })}
      />
      <PriorityField value={priority} onChange={setPriority} />
      <ModelField value={model} onChange={setModel} models={models} />
      <EffortField value={effort} onChange={setEffort} />
      <LaneField value={lane} onChange={setLane} lanes={lanes} />
      <AutoDoneField value={autoDone} onChange={setAutoDone} />
      <RepeatFields
        after={after}
        onAfterChange={setAfter}
        afterOptions={upstreams}
        ruleLines={ruleLines}
        onRuleLinesChange={setRuleLines}
        timezone={timezone}
        ruleError={ruleError}
        delay={delay}
        onDelayChange={setDelay}
        delayError={delayError}
        at={at}
        onAtChange={setAt}
        atError={atError}
        atDescription="The interval counts from here; the pending card moves to the next run after now"
        times={times}
        onTimesChange={setTimes}
        limit={limit}
        onLimitChange={setLimit}
        onEdit={update.reset}
      />
      {after === null && schedule.cron !== null && schedule.timezone !== null && schedule.timezone !== timezone && (
        <Text size="xs" c="dimmed">
          The schedule was set in {schedule.timezone}. Saving reads its expressions in {timezone} from now on.
        </Text>
      )}
      <Text size="xs" c="dimmed">
        The pending card takes the change too, unless a worker already started it.
        {schedule.until !== null && ' The end time stays; giving a number of runs replaces it.'}
      </Text>
      {update.error && (
        <Alert color="red" variant="light" title="Not saved">
          <Text size="sm">{errorMessage(update.error)}</Text>
        </Alert>
      )}
      <Group justify="flex-end">
        <Button
          variant="default"
          onClick={() => {
            clearText();
            onClose();
          }}
        >
          Cancel
        </Button>
        <Button onClick={save} disabled={!ready} loading={update.isPending}>
          Save
        </Button>
      </Group>
    </Stack>
  );
}

/** Everything of a schedule that New task, When: Repeating can set, filled in with the schedule's values. */
export function EditScheduleModal({
  schedule,
  opened,
  onClose,
}: {
  schedule: Schedule;
  opened: boolean;
  onClose: () => void;
}) {
  return (
    <Modal opened={opened} onClose={onClose} title="Edit schedule" size="lg">
      <EditScheduleForm schedule={schedule} onClose={onClose} />
    </Modal>
  );
}
