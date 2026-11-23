import {
  matchTitleRule,
  MAX_TITLE_INSTRUCTION_CHARS,
  MAX_TITLE_PATTERN_CHARS,
  MAX_TITLE_RULES,
  titleRuleProblem,
  type TitleRule,
} from '@agent-board/shared';
import {
  ActionIcon,
  Alert,
  Button,
  Checkbox,
  Group,
  Paper,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { IconAlertTriangle, IconPlus, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { useMemo, useState } from 'react';
import { EmojiPicker } from '../../components/EmojiPicker';
import { LabelsInput } from '../../components/LabelsEditor';
import { QueryStatus } from '../../components/QueryStatus';
import { ago, stamp } from '../../lib/time';
import { useTRPC } from '../../lib/trpc';

interface DraftRule {
  key: string;
  pattern: string;
  ignoreCase: boolean;
  icon: string | null;
  labels: string[];
  instruction: string;
}

const PATTERN_EXAMPLE = '^/pj-acme:review\\b';
const INSTRUCTION_EXAMPLE = 'The pull request number and its title, such as "#8 Fix the login redirect".';
const TRY_TEXT = '/pj-acme:review https://github.com/acme/app/pull/8';

const asRule = ({ pattern, ignoreCase, icon, labels, instruction }: DraftRule): TitleRule => ({
  pattern,
  ...(ignoreCase ? { flags: 'i' as const } : {}),
  ...(icon === null ? {} : { icon }),
  ...(labels.length === 0 ? {} : { labels }),
  ...(instruction === '' ? {} : { instruction }),
});

const sentence = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;

/** What is wrong with the pattern and with the instruction of a row; a field that is still empty shows nothing yet. */
function fieldProblems(draft: DraftRule): { pattern?: string; instruction?: string } {
  const filled = draft.pattern !== '';
  const problem = titleRuleProblem(asRule({ ...draft, pattern: filled ? draft.pattern : 'a' }));
  if (problem === undefined || (!filled && problem.startsWith('the rule sets no'))) return {};
  const text = sentence(problem);
  return problem.startsWith('the pattern') ? { pattern: text } : { instruction: text };
}

const isConflict = (error: unknown): boolean =>
  error instanceof TRPCClientError && (error.data as { code?: string } | undefined)?.code === 'CONFLICT';

function outcome(number: number, rule: TitleRule): string {
  const icon = rule.icon === undefined ? 'no icon' : `icon ${rule.icon}`;
  const labels = rule.labels === undefined ? 'no labels' : `labels ${rule.labels.join(', ')}`;
  const title = rule.instruction === undefined ? 'no title instruction' : 'Haiku writes the title from its instruction';
  return `Rule ${number} matches: ${icon}, ${labels}, ${title}.`;
}

/** The rules that give a new task an icon, labels and a model-written title; they live on the board sealed, and your machines read them. */
export function TitlesSettings() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const titles = useQuery(trpc.titleRules.get.queryOptions());
  const save = useMutation(trpc.titleRules.set.mutationOptions());
  // The version the edits start from: a refetch that finds a newer one must not let a save through over it.
  const [edit, setEdit] = useState<{ base: number; rows: DraftRule[] }>();
  const [added, setAdded] = useState(0);
  const [tryText, setTryText] = useState(TRY_TEXT);

  const stored = titles.data;
  const unreadable = stored !== undefined && stored !== null && stored.rules === null;
  const rows = useMemo<DraftRule[]>(
    () =>
      edit?.rows ??
      (stored?.rules ?? []).map((rule, index) => ({
        key: `saved-${stored?.version}-${index}`,
        pattern: rule.pattern,
        ignoreCase: rule.flags === 'i',
        icon: rule.icon ?? null,
        labels: rule.labels ?? [],
        instruction: rule.instruction ?? '',
      })),
    [edit, stored],
  );
  const problems = rows.map(fieldProblems);
  const invalid = rows.some((row) => titleRuleProblem(asRule(row)) !== undefined);

  const matched = useMemo(() => {
    const working = rows
      .map((row, index) => ({ rule: asRule(row), number: index + 1 }))
      .filter(({ rule }) => titleRuleProblem(rule) === undefined);
    const hit = matchTitleRule(
      working.map(({ rule }) => rule),
      tryText,
    );
    return hit === undefined ? undefined : outcome(working[hit.index]?.number ?? 0, hit.rule);
  }, [rows, tryText]);

  const base = edit?.base ?? stored?.version ?? 0;
  const edited = (next: DraftRule[]) => setEdit({ base, rows: next });
  const change = (key: string, patch: Partial<DraftRule>) =>
    edited(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const add = () => {
    setAdded(added + 1);
    edited([...rows, { key: `new-${added}`, pattern: '', ignoreCase: false, icon: null, labels: [], instruction: '' }]);
  };

  const onSave = () =>
    save.mutate(
      { rules: rows.map(asRule), expectedVersion: base },
      {
        onSuccess: async () => {
          await queryClient.invalidateQueries({ queryKey: trpc.titleRules.get.queryOptions().queryKey });
          setEdit(undefined);
        },
      },
    );

  return (
    <Paper withBorder p="md">
      <Stack>
        <div>
          <Title order={5}>Titles</Title>
          <Text size="sm" c="dimmed">
            When a task runs with the title it got by default, the first rule whose pattern matches its prompt applies.
            The rule&apos;s icon is set if the task has none, and its labels if the task has none. Haiku writes a title
            from the rule&apos;s instruction, reading only the pull request or issue the prompt names, with{' '}
            <code>gh</code> on the machine that runs the task. A title you typed or renamed, an icon or labels you chose
            and the cards of a repeating schedule are never touched. The rules are sealed with your key, and your
            machines read them with the same key.
          </Text>
        </div>
        <QueryStatus query={titles} what="title rules" />
        {unreadable && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
            The saved rules cannot be read with your key, so none apply. Saving replaces them.
          </Alert>
        )}
        {isConflict(save.error) && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
            The rules changed somewhere else since you opened this page. Reload the page to see them, then make your
            change again.
          </Alert>
        )}
        {stored && (
          <Text size="sm">
            Version {stored.version}, saved{' '}
            {stored.updatedAt === '' ? 'at an unknown time' : `${stamp(stored.updatedAt)} (${ago(stored.updatedAt)})`}.
          </Text>
        )}
        {titles.data !== undefined && rows.length === 0 && (
          <Text size="sm" c="dimmed">
            No rules yet.
          </Text>
        )}
        {rows.map((row, index) => (
          <Group key={row.key} align="flex-start" wrap="nowrap" gap="xs">
            <Stack flex={1} gap="xs">
              <Group align="flex-start" wrap="nowrap" gap="xs">
                <TextInput
                  flex={1}
                  aria-label={`Pattern of rule ${index + 1}`}
                  placeholder={PATTERN_EXAMPLE}
                  value={row.pattern}
                  maxLength={MAX_TITLE_PATTERN_CHARS}
                  error={problems[index]?.pattern}
                  onChange={(event) => change(row.key, { pattern: event.currentTarget.value })}
                  styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
                />
                <Checkbox
                  mt={8}
                  label="Ignore case"
                  aria-label={`Ignore case in rule ${index + 1}`}
                  checked={row.ignoreCase}
                  onChange={(event) => change(row.key, { ignoreCase: event.currentTarget.checked })}
                />
                <EmojiPicker
                  value={row.icon}
                  onChange={(icon) => change(row.key, { icon })}
                  size={18}
                  label={`Icon of rule ${index + 1}`}
                />
              </Group>
              <LabelsInput
                ariaLabel={`Labels of rule ${index + 1}`}
                value={row.labels}
                onChange={(labels) => change(row.key, { labels })}
              />
              <Textarea
                aria-label={`Title instruction of rule ${index + 1}`}
                placeholder={INSTRUCTION_EXAMPLE}
                autosize
                minRows={2}
                value={row.instruction}
                maxLength={MAX_TITLE_INSTRUCTION_CHARS}
                error={problems[index]?.instruction}
                onChange={(event) => change(row.key, { instruction: event.currentTarget.value })}
              />
            </Stack>
            <ActionIcon
              mt={4}
              variant="subtle"
              color="red"
              aria-label={`Remove rule ${index + 1}`}
              onClick={() => edited(rows.filter(({ key }) => key !== row.key))}
            >
              <IconTrash size={16} />
            </ActionIcon>
          </Group>
        ))}
        <Group>
          <Button
            size="xs"
            variant="default"
            leftSection={<IconPlus size={14} />}
            disabled={titles.data === undefined || rows.length >= MAX_TITLE_RULES}
            onClick={add}
          >
            Add rule
          </Button>
          <Button
            size="xs"
            loading={save.isPending}
            disabled={(edit === undefined && !unreadable) || invalid || titles.data === undefined}
            onClick={onSave}
          >
            Save
          </Button>
        </Group>
        <Textarea
          label="Try it"
          description="A prompt, tested against the rules above, saved or not."
          autosize
          minRows={2}
          value={tryText}
          onChange={(event) => setTryText(event.currentTarget.value)}
        />
        <Text size="sm">{matched ?? 'No rule matches: the task keeps its title, icon and labels.'}</Text>
      </Stack>
    </Paper>
  );
}
