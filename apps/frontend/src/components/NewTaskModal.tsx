import type { Priority } from '@agent-board/shared';
import { Box, Button, Code, Group, Modal, Select, Stack, Text, TextInput } from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { skillsFor } from '../lib/catalog';
import { DEFAULT_EFFORT, effortFromOption } from '../lib/effort';
import { DEFAULT_LANE } from '../lib/lane';
import { readLastDirectory, writeLastDirectory } from '../lib/lastDirectory';
import { DEFAULT_MODEL } from '../lib/model';
import { parseDelay, parseRepeatRule } from '../lib/repeat';
import { errorMessage, useTRPC } from '../lib/trpc';
import { useNow } from '../lib/useNow';
import { DirectorySelect } from './DirectorySelect';
import { EmojiPicker } from './EmojiPicker';
import { LabelsInput } from './LabelsEditor';
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
import { useDirectoryChoices } from './useDirectoryChoices';
import { useLaneOptions } from './useLaneOptions';
import { useModelOptions } from './useModelOptions';

const WHEN_LABEL = { now: 'Now', later: 'Later', repeat: 'Repeating', backlog: 'Backlog', hold: 'Needs me' } as const;
type When = keyof typeof WHEN_LABEL;

interface Props {
  opened: boolean;
  onClose: () => void;
  /** Text to start from; read when the modal mounts, so give a new one a new `key`. */
  initial?: { title: string; input: string };
  /** After the task exists. */
  onCreated?: () => void;
}

/** A prompt, as you would type it into Claude Code, and optionally the directory of a machine it runs in. */
export function NewTaskModal({ opened, onClose, initial, onCreated }: Props) {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [input, setInput] = useState(initial?.input ?? '');
  const [when, setWhen] = useState<When>('now');
  const [at, setAt] = useState('');
  const [ruleLines, setRuleLines] = useState<string[]>(['']);
  const [times, setTimes] = useState<number | string>('');
  const [limit, setLimit] = useState<number | string>('');
  const [after, setAfter] = useState<string | null>(null);
  const [delay, setDelay] = useState('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [effort, setEffort] = useState(DEFAULT_EFFORT);
  const [lane, setLane] = useState(DEFAULT_LANE);
  const [autoDone, setAutoDone] = useState(false);
  const [directory, setDirectory] = useState<string | null>(readLastDirectory);
  const [agent, setAgent] = useState('');
  const [icon, setIcon] = useState<string | null>(null);
  const [labels, setLabels] = useState<string[]>([]);
  const directories = useDirectoryChoices();
  const catalogs = useQuery(trpc.machines.catalogs.queryOptions());
  const create = useMutation(trpc.tasks.create.mutationOptions());
  const schedules = useQuery({ ...trpc.schedules.list.queryOptions(), enabled: opened && when === 'repeat' });

  const now = useNow(30_000);
  const start = new Date(at);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const rule = ruleLines.join('\n');
  const parsedRule = parseRepeatRule(rule, timezone);
  const place = directories.choices.find(({ value }) => value === directory);
  const skills = useMemo(
    () => skillsFor(catalogs.data ?? [], { machine: place?.machine, workdir: place?.path }),
    [catalogs.data, place?.machine, place?.path],
  );
  const models = useModelOptions(place?.machine, model);
  const lanes = useLaneOptions(place?.machine, lane);
  const agentName = agent.trim();
  const agentError = agentNameError(agentName);
  const startsLater = when === 'later' || when === 'repeat';
  const atError = startsLater && at !== '' && !(start.getTime() > now) ? 'Pick a time in the future' : undefined;
  const afterOptions = (schedules.data ?? [])
    .filter(({ ended }) => !ended)
    .map(({ id, title }) => ({ value: id, label: title }));
  const delayMs = parseDelay(delay);
  const delayError = after !== null && delayMs === undefined ? 'A duration such as 10m, 2h or 1d' : undefined;
  const afterRule = after !== null && delayMs !== undefined ? { after: { scheduleId: after, delayMs } } : undefined;
  const ruleError =
    when === 'repeat' && after === null && rule.trim() !== '' && 'error' in parsedRule ? parsedRule.error : undefined;
  const repeat = after !== null ? afterRule : 'error' in parsedRule ? undefined : parsedRule;
  const ready =
    input.trim() !== '' &&
    agentError === undefined &&
    (when !== 'later' || (at !== '' && atError === undefined)) &&
    (when !== 'repeat' ||
      (repeat !== undefined &&
        (after !== null || atError === undefined) &&
        timesError(times) === undefined &&
        limitError(limit) === undefined));
  const submit = () => {
    if (!ready || create.isPending) return;
    const schedule = repeat && {
      ...repeat,
      ...(at !== '' && after === null ? { at: start } : {}),
      ...(times !== '' ? { times: Number(times) } : {}),
      ...(limit !== '' ? { maxConcurrent: Number(limit) } : {}),
    };
    const chosenEffort = effortFromOption(effort);
    const payload = when === 'later' ? { at: start } : when === 'repeat' ? schedule : when;
    if (payload === undefined) return;
    create.mutate(
      {
        title,
        input,
        when: payload,
        priority,
        ...(model === DEFAULT_MODEL ? {} : { model }),
        ...(chosenEffort === null ? {} : { effort: chosenEffort }),
        ...(lane === DEFAULT_LANE ? {} : { lane }),
        ...(autoDone ? { autoDone } : {}),
        ...(place === undefined ? {} : { place: { machine: place.machine, workdir: place.path } }),
        ...(agentName === '' ? {} : { agent: agentName }),
        ...(icon === null ? {} : { icon }),
        ...(labels.length === 0 ? {} : { labels }),
      },
      {
        onSuccess: (task) => {
          onCreated?.();
          writeLastDirectory(place?.value ?? null);
          setTitle('');
          setInput('');
          setPriority('normal');
          setWhen('now');
          setModel(DEFAULT_MODEL);
          setEffort(DEFAULT_EFFORT);
          setLane(DEFAULT_LANE);
          setAutoDone(false);
          setDirectory(place?.value ?? null);
          setAgent('');
          setIcon(null);
          setLabels([]);
          setAt('');
          setRuleLines(['']);
          setTimes('');
          setLimit('');
          setAfter(null);
          setDelay('');
          onClose();
          navigate(task === null ? '/schedules' : `/t/${task.id}`);
        },
      },
    );
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap={6} wrap="nowrap">
          <EmojiPicker value={icon} onChange={setIcon} size={18} label="New task icon" />
          <span>New task</span>
        </Group>
      }
      size="lg"
    >
      <Stack>
        <MarkdownEditor
          label="Prompt"
          value={input}
          onChange={setInput}
          minRows={6}
          onSubmit={submit}
          autoFocus
          skills={skills}
          placeholder={'/review-pr 17741\n\nor any instruction, as you would type it into Claude Code'}
        />
        <Text size="xs" c="dimmed" mt={-8}>
          Type <Code>/</Code> to pick a skill of the chosen machine and directory. Without a working directory it runs
          in the default directory of whichever machine takes it. The Lane field below sets the lane it runs in.
        </Text>
        <DirectorySelect
          label="Working directory"
          directories={directories}
          value={place?.value ?? null}
          onChange={setDirectory}
        />
        <AgentField value={agent} onChange={setAgent} />
        <TextInput
          label="Title"
          placeholder="Defaults to the prompt's first line"
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
        />
        <LabelsInput label="Labels" value={labels} onChange={setLabels} />
        <PriorityField value={priority} onChange={setPriority} />
        <ModelField value={model} onChange={setModel} models={models} />
        <EffortField value={effort} onChange={setEffort} />
        <LaneField value={lane} onChange={setLane} lanes={lanes} />
        <AutoDoneField value={autoDone} onChange={setAutoDone} />
        <div>
          <Text size="sm" fw={500} mb={4}>
            When
          </Text>
          <Select
            aria-label="When"
            allowDeselect={false}
            value={when}
            onChange={(value) => value && setWhen(value as When)}
            data={Object.entries(WHEN_LABEL).map(([value, label]) => ({ value, label }))}
          />
          {when === 'later' && (
            <TextInput
              mt="xs"
              type="datetime-local"
              aria-label="Start time"
              required
              value={at}
              onChange={(e) => setAt(e.currentTarget.value)}
              error={atError}
              description="It waits in Todo and no worker takes it before then"
            />
          )}
          {when === 'repeat' && (
            <Box mt="xs">
              <RepeatFields
                after={after}
                onAfterChange={setAfter}
                afterOptions={afterOptions}
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
                atDescription="Default: now"
                times={times}
                onTimesChange={setTimes}
                limit={limit}
                onLimitChange={setLimit}
                saveError={create.error ? errorMessage(create.error) : undefined}
                onEdit={create.reset}
              />
            </Box>
          )}
        </div>
        <Group justify="flex-end">
          <Button onClick={submit} disabled={!ready} loading={create.isPending}>
            Create
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
