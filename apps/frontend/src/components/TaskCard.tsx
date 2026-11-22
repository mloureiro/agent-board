import { prsOf } from '@agent-board/shared';
import { ActionIcon, Card, Group, Stack, Text, Tooltip } from '@mantine/core';
import { IconTerminal2, IconWand } from '@tabler/icons-react';
import type { DragEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ago } from '../lib/time';
import type { LastNote, ListedTask } from '../lib/trpc';
import type { TaskHold } from '../lib/usageHold';
import { EmojiPicker } from './EmojiPicker';
import { LabelsEditor } from './LabelsEditor';
import { LivenessText } from './LivenessText';
import { PrStateIcon } from './PrStateIcon';
import { TaskBadges } from './TaskBadges';

/** The latest note as one line: who said what, how long ago. */
function lastNoteLine(note: LastNote | null, task: ListedTask): string {
  if (!note) return `created ${ago(task.createdAt)}`;
  const text =
    note.kind === 'question'
      ? 'asked a question'
      : note.kind === 'answer'
        ? 'answered'
        : note.kind === 'polish'
          ? 'polished a prompt'
          : note.text
              .replace(/[#*`>_]/g, '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 90);
  return `${note.author}: ${text} · ${ago(note.createdAt)}`;
}

/** How many pull requests a card shows an icon for; the rest are a count. */
const MAX_PR_ICONS = 3;

interface Props {
  task: ListedTask;
  draggable: boolean;
  dragging: boolean;
  onDragStart: (event: DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent) => void;
  /** Queues a polish of this Backlog task's prompt; absent when it cannot be polished. */
  onPolish?: () => void;
  onIconChange?: (icon: string | null) => void;
  onLabelsChange?: (labels: string[]) => void;
  labelSuggestions?: readonly string[];
  polishDisabled?: boolean;
  /** Why the task has not started for usage; absent when it is not held. */
  hold?: TaskHold | undefined;
}

export function TaskCard({
  task,
  draggable,
  dragging,
  onDragStart,
  onDragEnd,
  onDragOver,
  onPolish,
  onIconChange,
  onLabelsChange,
  labelSuggestions,
  polishDisabled = false,
  hold,
}: Props) {
  const prs = prsOf(task);
  const navigate = useNavigate();
  return (
    <Card
      component={Link}
      to={`/t/${task.id}`}
      withBorder
      padding="sm"
      className="task-card"
      data-dragging={dragging}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      style={{
        cursor: draggable ? 'grab' : 'pointer',
        borderLeft: task.openQuestion ? '3px solid var(--mantine-color-orange-6)' : undefined,
      }}
    >
      <Stack gap={6}>
        <Group gap={6} wrap="nowrap" align="flex-start">
          {onIconChange ? (
            <EmojiPicker value={task.icon ?? null} onChange={onIconChange} size={16} revealOnHover />
          ) : (
            task.icon && (
              <span
                className="emoji-trigger"
                style={{ fontSize: 16, width: 20, height: 20 }}
                role="img"
                aria-label="Task icon"
              >
                {task.icon}
              </span>
            )
          )}
          {prs.length > 0 && (
            <span style={{ display: 'flex', gap: 2, alignItems: 'center', marginTop: 2 }}>
              {prs.slice(0, MAX_PR_ICONS).map(({ url, state }) => (
                <PrStateIcon key={url} state={state} />
              ))}
              {prs.length > MAX_PR_ICONS && (
                <Text size="xs" c="dimmed" aria-label={`${prs.length - MAX_PR_ICONS} more pull requests`}>
                  +{prs.length - MAX_PR_ICONS}
                </Text>
              )}
            </span>
          )}
          <Text size="sm" fw={500} lineClamp={2} className="wrap-anywhere" style={{ flex: 1 }}>
            {task.title}
          </Text>
          {onPolish && (
            <Tooltip label={polishDisabled ? 'A polish task is already open' : 'Polish prompt'}>
              <ActionIcon
                size="sm"
                variant="subtle"
                color="gray"
                aria-label="Polish prompt"
                disabled={polishDisabled}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onPolish();
                }}
              >
                <IconWand size={14} />
              </ActionIcon>
            </Tooltip>
          )}
          {(task.status === 'running' || task.sessionId !== null) && (
            <Tooltip label="Transcript">
              <ActionIcon
                size="sm"
                variant="subtle"
                color="gray"
                aria-label="Transcript"
                onClick={(event) => {
                  // The card is a link to the task; this opens its transcript instead.
                  event.preventDefault();
                  event.stopPropagation();
                  navigate(`/t/${task.id}?transcript=1`);
                }}
              >
                <IconTerminal2 size={14} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
        <TaskBadges task={task} hold={hold}>
          {onLabelsChange && (
            <LabelsEditor
              value={task.labels}
              onChange={onLabelsChange}
              {...(labelSuggestions === undefined ? {} : { suggestions: labelSuggestions })}
              size={12}
              revealOnHover
            />
          )}
        </TaskBadges>
        {task.status === 'running' && <LivenessText size="xs" lastActiveAt={task.lastActiveAt} />}
        <Text size="xs" c="dimmed" lineClamp={1} className="wrap-anywhere">
          {lastNoteLine(task.lastNote, task)}
        </Text>
      </Stack>
    </Card>
  );
}
