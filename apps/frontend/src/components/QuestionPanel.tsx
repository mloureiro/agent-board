import type { Answer, Question } from '@agent-board/shared';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Kbd,
  Paper,
  Radio,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { IconAlertTriangle, IconMessageQuestion, IconPlayerPlay } from '@tabler/icons-react';
import { modals } from '@mantine/modals';
import { useState } from 'react';
import { MarkdownEditor } from './MarkdownEditor';

interface Draft {
  selected: string[];
  other: string;
}

const initial = (questions: Question[]): Draft[] =>
  questions.map((q) => ({ selected: q.options.filter((o) => o.recommended).map((o) => o.label), other: '' }));

export const isAnswered = (draft: Draft): boolean => draft.selected.length > 0 || draft.other.trim() !== '';

export function toAnswers(drafts: Draft[]): Answer[] {
  return drafts.map((d) =>
    d.other.trim() ? { selected: d.selected, other: d.other.trim() } : { selected: d.selected },
  );
}

interface Props {
  /** What the board serves now under the open question's note id. The panel shows the first value it saw. */
  questions: Question[];
  submitting: boolean;
  /** `questions` are the ones this panel showed, which the answers are checked against and sealed with. */
  onSubmit: (questions: Question[], answers: Answer[], message: string) => void;
  /** Drops the questions without an answer. The panel asks the user to confirm first. */
  onDismiss: () => void;
  dismissing: boolean;
  /** Text typed in the reply box before the question arrived: the start value of the note. */
  handover?: string;
  /** Focus the note, caret at its end. */
  focusNote?: boolean;
}

interface FormProps extends Props {
  questions: Question[];
}

function confirmDismiss(onConfirm: () => void): void {
  modals.openConfirmModal({
    title: 'Dismiss the questions?',
    children: (
      <Text size="sm">
        The agent’s questions are dropped without an answer. The task stays in Needs me, where you can reply, start over
        or finish it.
      </Text>
    ),
    labels: { confirm: 'Dismiss questions', cancel: 'Cancel' },
    confirmProps: { color: 'red' },
    onConfirm,
  });
}

function DismissButton({ onDismiss, dismissing }: Pick<Props, 'onDismiss' | 'dismissing'>) {
  return (
    <Button variant="default" onClick={() => confirmDismiss(onDismiss)} loading={dismissing}>
      Dismiss questions
    </Button>
  );
}

const sameQuestions = (a: Question[], b: Question[]): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The agent's open question, answered like AskUserQuestion in the terminal. The questions are frozen when the panel mounts:
 * the answer is sealed with what was on screen. A question note is immutable, so if the board later serves other questions
 * under the same note id, nothing is swapped in silently: the form is replaced by a notice, the picks are dropped, and the
 * user chooses to look at the changed questions, which starts a new set of picks.
 */
export function QuestionPanel({ questions, submitting, onSubmit, onDismiss, dismissing, handover, focusNote }: Props) {
  const [shown, setShown] = useState(questions);
  const [round, setRound] = useState(0);
  if (!sameQuestions(shown, questions))
    return (
      <Paper withBorder p="md" radius="md" style={{ borderColor: 'var(--mantine-color-red-5)' }}>
        <Stack>
          <Alert color="red" icon={<IconAlertTriangle size={18} />} title="The question changed">
            <Text size="sm">
              The board is now serving other questions under the one you were answering. An agent’s question is never
              edited, so the board may be misleading you. Your picks were dropped and nothing was sent. Read the changed
              questions carefully before you answer, or leave the task alone.
            </Text>
          </Alert>
          <Group justify="flex-end">
            <DismissButton onDismiss={onDismiss} dismissing={dismissing} />
            <Button
              variant="default"
              onClick={() => {
                setShown(questions);
                setRound((current) => current + 1);
              }}
            >
              Show the changed questions
            </Button>
          </Group>
        </Stack>
      </Paper>
    );
  return (
    <QuestionForm
      key={round}
      questions={shown}
      submitting={submitting}
      onSubmit={onSubmit}
      onDismiss={onDismiss}
      dismissing={dismissing}
      handover={handover}
      focusNote={focusNote}
    />
  );
}

/** A drawer or modal covers the form, so a key pressed there must not change the answer behind it. */
const isOverlayOpen = (): boolean => document.querySelector('[role="dialog"]') !== null;

function QuestionForm({ questions, submitting, onSubmit, onDismiss, dismissing, handover = '', focusNote }: FormProps) {
  const [drafts, setDrafts] = useState<Draft[]>(() => initial(questions));
  const [active, setActive] = useState(0);
  const [message, setMessage] = useState(handover);
  const ready = drafts.every((draft, index) => questions[index]?.multiSelect || isAnswered(draft));

  const update = (index: number, change: Partial<Draft>) =>
    setDrafts((current) => current.map((d, i) => (i === index ? { ...d, ...change } : d)));

  const pick = (index: number, label: string) => {
    const question = questions[index];
    const draft = drafts[index];
    if (!question || !draft) return;
    setActive(index);
    if (question.multiSelect) {
      const selected = draft.selected.includes(label)
        ? draft.selected.filter((l) => l !== label)
        : [...draft.selected, label];
      update(index, { selected });
    } else if (draft.selected.includes(label)) {
      // Picking the chosen option again drops it, so the answer can be none of the options.
      update(index, { selected: [] });
    } else {
      update(index, { selected: [label] });
      // A single choice is made: go on to the next question.
      if (index < questions.length - 1) setActive(index + 1);
    }
  };

  const submit = () => {
    if (ready && !submitting) onSubmit(questions, toAnswers(drafts), message);
  };

  useHotkeys([
    ...[1, 2, 3, 4].map(
      (n) =>
        [
          String(n),
          () => {
            const option = questions[active]?.options[n - 1];
            if (option && !isOverlayOpen()) pick(active, option.label);
          },
        ] as [string, () => void],
    ),
    ['mod+Enter', () => !isOverlayOpen() && submit()],
  ]);

  return (
    <Paper withBorder p="md" radius="md" style={{ borderColor: 'var(--mantine-color-orange-5)' }}>
      <Stack gap="lg">
        <Group gap="xs">
          <IconMessageQuestion size={20} color="var(--mantine-color-orange-6)" />
          <Text fw={600}>The agent is waiting for your answer</Text>
        </Group>
        {questions.map((question, index) => {
          const draft = drafts[index]!;
          return (
            <Stack
              key={index}
              gap="xs"
              onFocusCapture={() => setActive(index)}
              onMouseDown={() => setActive(index)}
              p="xs"
              style={{
                borderRadius: 'var(--mantine-radius-md)',
                outline:
                  questions.length > 1 && active === index ? '1px solid var(--mantine-color-indigo-3)' : undefined,
              }}
            >
              <Group gap="xs" wrap="nowrap" align="flex-start">
                <Badge variant="light" tt="none" style={{ flexShrink: 0 }}>
                  {question.header}
                </Badge>
                <Text size="sm" fw={500} className="wrap-anywhere">
                  {question.question}
                  {question.multiSelect && (
                    <Text span size="xs" c="dimmed">
                      {' '}
                      (pick any)
                    </Text>
                  )}
                </Text>
              </Group>
              <SimpleGrid
                cols={{ base: 1, sm: question.options.length > 2 ? 2 : question.options.length }}
                spacing="xs"
              >
                {question.options.map((option, optionIndex) => {
                  const chosen = draft.selected.includes(option.label);
                  const Card = question.multiSelect ? Checkbox.Card : Radio.Card;
                  return (
                    <Card
                      key={option.label}
                      value={option.label}
                      checked={chosen}
                      onClick={() => pick(index, option.label)}
                      radius="md"
                      p="sm"
                      style={{
                        borderColor: chosen ? 'var(--mantine-color-indigo-5)' : undefined,
                        background: chosen ? 'var(--mantine-color-indigo-light)' : undefined,
                      }}
                    >
                      <Group wrap="nowrap" align="flex-start" gap="sm">
                        {question.multiSelect ? (
                          <Checkbox.Indicator checked={chosen} />
                        ) : (
                          <Radio.Indicator checked={chosen} />
                        )}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <Group gap={6} justify="space-between" wrap="nowrap">
                            <Text size="sm" fw={500} className="wrap-anywhere">
                              {option.label}
                            </Text>
                            <Group gap={4} wrap="nowrap">
                              {option.recommended && (
                                <Badge size="xs" color="teal" variant="light">
                                  Recommended
                                </Badge>
                              )}
                              {active === index && <Kbd size="xs">{optionIndex + 1}</Kbd>}
                            </Group>
                          </Group>
                          {option.description && (
                            <Text size="xs" c="dimmed" mt={2} className="wrap-anywhere">
                              {option.description}
                            </Text>
                          )}
                        </div>
                      </Group>
                    </Card>
                  );
                })}
              </SimpleGrid>
              <Group gap="xs" wrap="nowrap" align="flex-start">
                <Textarea
                  size="xs"
                  style={{ flex: 1 }}
                  autosize
                  minRows={1}
                  placeholder={
                    question.multiSelect || draft.selected.length === 0 ? 'Other…' : 'Other… (replaces your choice)'
                  }
                  value={draft.other}
                  onChange={(event) => {
                    const other = event.currentTarget.value;
                    const startsTyping = !question.multiSelect && draft.other === '' && other !== '';
                    update(index, startsTyping ? { other, selected: [] } : { other });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      submit();
                    }
                  }}
                />
                {!question.multiSelect && draft.selected.length > 0 && (
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="gray"
                    onClick={() => update(index, { selected: [] })}
                  >
                    None of these
                  </Button>
                )}
              </Group>
            </Stack>
          );
        })}
        <MarkdownEditor
          value={message}
          onChange={setMessage}
          minRows={2}
          onSubmit={submit}
          autoFocus={focusNote}
          placeholder="Anything else the agent should know (optional)"
        />
        <Group justify="space-between">
          <Text size="xs" c="dimmed">
            {questions.length > 1 ? 'Number keys pick in the highlighted question. ' : 'Number keys pick an option. '}
            <Kbd size="xs">⌘</Kbd>+<Kbd size="xs">Enter</Kbd> sends.
          </Text>
          <Group gap="xs">
            <DismissButton onDismiss={onDismiss} dismissing={dismissing} />
            <Button leftSection={<IconPlayerPlay size={16} />} onClick={submit} disabled={!ready} loading={submitting}>
              Answer &amp; continue
            </Button>
          </Group>
        </Group>
      </Stack>
    </Paper>
  );
}
