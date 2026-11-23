import type { CatalogSkill } from '@agent-board/shared';
import { Alert, Anchor, Button, Group, Kbd, Loader, Menu, Paper, Stack, Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import {
  IconArchive,
  IconArchiveOff,
  IconArrowBackUp,
  IconAlarm,
  IconCheck,
  IconChevronDown,
  IconInbox,
  IconMessage,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
  IconSparkles,
  IconWand,
} from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { openQuestionOf } from '../lib/answers';
import { canTakeBack } from '../lib/liveness';
import { canPolish, isOpenPolishOf } from '../lib/polish';
import { isStopHintDue, isStopping, STOP_LABEL, stopKind } from '../lib/stopping';
import { currentSuggestion } from '../lib/suggestion';
import { startsIn } from '../lib/startsIn';
import { ago, stamp } from '../lib/time';
import { useNow } from '../lib/useNow';
import { useTRPC, type BoardTask, type ThreadNote } from '../lib/trpc';
import { LivenessText } from './LivenessText';
import { MarkdownEditor } from './MarkdownEditor';
import { confirmStart, moveConfirmed } from './confirmStart';
import { QuestionPanel } from './QuestionPanel';
import { usePolish } from './usePolish';

function useActions(id: string) {
  const trpc = useTRPC();
  return {
    answer: useMutation(trpc.tasks.answer.mutationOptions()),
    dismissQuestion: useMutation(trpc.tasks.dismissQuestion.mutationOptions()),
    reply: useMutation(trpc.tasks.reply.mutationOptions()),
    send: useMutation(trpc.tasks.send.mutationOptions()),
    stop: useMutation(trpc.tasks.stop.mutationOptions()),
    done: useMutation(trpc.tasks.done.mutationOptions()),
    rerun: useMutation(trpc.tasks.rerun.mutationOptions()),
    close: useMutation(trpc.tasks.setClosed.mutationOptions()),
    move: useMutation(trpc.tasks.move.mutationOptions()),
    takeBack: useMutation(trpc.tasks.takeBack.mutationOptions()),
    setNotBefore: useMutation(trpc.tasks.setNotBefore.mutationOptions()),
    wakeNow: useMutation(trpc.tasks.wakeNow.mutationOptions()),
    id,
  };
}

type Actions = ReturnType<typeof useActions>;

/** What differs per status around the one reply editor. */
interface Shell {
  header: ReactNode;
  footer: ReactNode;
  placeholder: string;
  minRows: number;
  onSubmit: () => void;
  suggestion?: string;
  skills?: readonly CatalogSkill[];
}

interface ShellContext {
  task: BoardTask;
  thread: ThreadNote[];
  actions: Actions;
  message: string;
  setMessage: (message: string) => void;
  skills?: readonly CatalogSkill[];
  isProposal: boolean;
  polishing: boolean;
  polish: ReturnType<typeof usePolish>;
  waiting: boolean;
  stopClickedAt: number | null;
  setStopClickedAt: (at: number) => void;
  now: number;
}

/**
 * The reply editor under a header and a footer. The tree is the same for every status, so a status change that
 * arrives while the user types keeps the same textarea, with its focus and selection.
 */
function Composer({
  shell,
  message,
  setMessage,
  onFocusChange,
}: {
  shell: Shell;
  message: string;
  setMessage: (message: string) => void;
  onFocusChange: (focused: boolean) => void;
}) {
  return (
    <Paper withBorder p="md">
      <Stack>
        {shell.header}
        <div onFocus={() => onFocusChange(true)} onBlur={() => onFocusChange(false)}>
          <MarkdownEditor
            key="reply"
            value={message}
            onChange={setMessage}
            minRows={shell.minRows}
            onSubmit={shell.onSubmit}
            suggestion={shell.suggestion}
            skills={shell.skills}
            placeholder={shell.placeholder}
          />
        </div>
        {shell.footer}
      </Stack>
    </Paper>
  );
}

function commentFooter({ actions, message, send }: { actions: Actions; message: string; send: () => void }) {
  return (
    <Group justify="flex-end">
      <Button
        variant="default"
        leftSection={<IconMessage size={16} />}
        onClick={send}
        disabled={!message.trim()}
        loading={actions.reply.isPending}
      >
        Comment
      </Button>
    </Group>
  );
}

/** Stop for a task that is not running: it holds an answer back (Todo) or ends a wait. */
function StopButton({ task, actions }: { task: BoardTask; actions: ReturnType<typeof useActions> }) {
  const kind = stopKind(task);
  if (kind === null || kind === 'run') return null;
  return (
    <Button
      size="xs"
      variant="default"
      color="red"
      leftSection={<IconPlayerStop size={14} />}
      onClick={() => actions.stop.mutate({ id: task.id })}
      loading={actions.stop.isPending}
      title={STOP_LABEL[kind]}
    >
      Stop
    </Button>
  );
}

/** For a running task whose agent has gone quiet: its worker is probably gone, and only that machine could end the run. */
function TakeBack({ task, actions }: { task: BoardTask; actions: ReturnType<typeof useActions> }) {
  const now = useNow(10_000);
  if (!canTakeBack(task.lastActiveAt, now)) return null;
  const confirm = () =>
    modals.openConfirmModal({
      title: 'Take the task back?',
      children: (
        <Text size="sm">
          The agent has been quiet for a while, so {task.machine ?? 'its worker'} may be off. The task moves to Needs
          me. If the worker is still alive, its result is dropped.
        </Text>
      ),
      labels: { confirm: 'Take back', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => actions.takeBack.mutate({ id: task.id }),
    });
  return (
    <Group justify="flex-end">
      <Button
        variant="default"
        color="red"
        leftSection={<IconArrowBackUp size={16} />}
        onClick={confirm}
        loading={actions.takeBack.isPending}
      >
        Take back
      </Button>
    </Group>
  );
}

function runningShell(c: ShellContext): Shell {
  const { task, actions, message, setMessage } = c;
  const stopping = isStopping(task);
  const hasText = message.trim() !== '';
  const clear = { onSuccess: () => setMessage('') };
  const send = () => hasText && !actions.send.isPending && actions.send.mutate({ id: task.id, message }, clear);
  const stop = (text?: string) => {
    if (actions.stop.isPending) return;
    c.setStopClickedAt(Date.now());
    actions.stop.mutate({ id: task.id, message: text }, text === undefined ? undefined : clear);
  };
  const stopDisabled = stopping || actions.stop.isPending;
  return {
    minRows: 2,
    onSubmit: send,
    placeholder: 'Message the running agent: it gets it at its next tool call, without being interrupted',
    header: (
      <>
        <Group gap="sm">
          <Loader size="xs" />
          <Text size="sm">
            Running on <b>{task.machine ?? 'a worker'}</b>
            {task.lane ? ` in the ${task.lane} lane${task.borrowed ? ' (borrowed)' : ''}` : ''}
            {task.runStartedAt ? ` since ${ago(task.runStartedAt)}` : ''}
            {' · '}
            <LivenessText span size="sm" lastActiveAt={task.lastActiveAt} />. It reports back here when it is done or
            has a question.
          </Text>
        </Group>
        <TakeBack task={task} actions={actions} />
        {stopping && (
          <Group gap="xs">
            <Loader size="xs" color="red" />
            <Text size="sm" c="red">
              Stopping…
            </Text>
          </Group>
        )}
        {stopping && isStopHintDue(c.stopClickedAt, c.now) && (
          <Alert color="yellow" variant="light">
            <Text size="sm">
              The stop request has not been acted on for a minute. The CLI on {task.machine ?? 'its machine'} may be too
              old to stop runs. Take back, offered once the agent has been quiet for 20 minutes, is the fallback.
            </Text>
          </Alert>
        )}
      </>
    ),
    footer: (
      <Group justify="space-between" wrap="wrap">
        <Group gap="xs">
          <Button
            variant="default"
            color="red"
            leftSection={<IconPlayerStop size={16} />}
            onClick={() => stop()}
            disabled={stopDisabled}
            title={STOP_LABEL.run}
          >
            Stop
          </Button>
          <Button
            variant="subtle"
            color="gray"
            leftSection={<IconMessage size={16} />}
            onClick={() =>
              hasText &&
              !actions.reply.isPending &&
              actions.reply.mutate({ id: task.id, message, resume: false }, clear)
            }
            disabled={!hasText || actions.reply.isPending}
            loading={actions.reply.isPending}
          >
            Comment without continuing
          </Button>
        </Group>
        <Group gap="xs">
          <Text size="xs" c="dimmed" visibleFrom="sm">
            <Kbd size="xs">⌘</Kbd>+<Kbd size="xs">Enter</Kbd>
          </Text>
          <Button
            variant="default"
            leftSection={<IconPlayerStop size={16} />}
            onClick={() => stop(message)}
            disabled={!hasText || stopDisabled}
            title="Interrupt the agent, then give it this message"
          >
            Stop & send
          </Button>
          <Button
            leftSection={<IconPlayerPlay size={16} />}
            onClick={send}
            disabled={!hasText || actions.send.isPending}
            loading={actions.send.isPending}
          >
            Send
          </Button>
        </Group>
      </Group>
    ),
  };
}

function commentShell(c: ShellContext, header: ReactNode, hint: string): Shell {
  const { task, actions, message, setMessage } = c;
  const send = () =>
    message.trim() &&
    actions.reply.mutate({ id: task.id, message, resume: false }, { onSuccess: () => setMessage('') });
  return { header, footer: commentFooter({ actions, message, send }), minRows: 2, onSubmit: send, placeholder: hint };
}

function backlogShell(c: ShellContext, moveToTodo: () => void): Shell {
  const { task, actions, isProposal, polishing, polish } = c;
  const header = (
    <>
      {isProposal ? (
        <Alert color="grape" variant="light" icon={<IconSparkles size={18} />} title="Proposed by an agent">
          <Group justify="space-between" wrap="nowrap">
            <Text size="sm">Nothing runs until you start it, which shows you its whole prompt first.</Text>
            <Group gap="xs" wrap="nowrap">
              <Button
                size="xs"
                color="grape"
                leftSection={<IconPlayerPlay size={14} />}
                onClick={moveToTodo}
                loading={actions.move.isPending}
              >
                Start
              </Button>
              <Button size="xs" variant="default" onClick={() => actions.close.mutate({ id: task.id, closed: true })}>
                Discard
              </Button>
            </Group>
          </Group>
        </Alert>
      ) : (
        <Group justify="space-between" wrap="nowrap">
          <Text size="sm">Parked. No worker takes it until you move it to Todo.</Text>
          <Button
            size="xs"
            leftSection={<IconPlayerPlay size={14} />}
            onClick={moveToTodo}
            loading={actions.move.isPending}
          >
            Move to Todo
          </Button>
        </Group>
      )}
      {canPolish(task) && (
        <Group justify="space-between" wrap="nowrap">
          <Text size="sm" c="dimmed">
            {polishing
              ? 'A polish task is already open; apply its polished prompt from there.'
              : 'Rough notes? Have an agent write a clearer prompt. Nothing changes until you apply it.'}
          </Text>
          <Button
            size="xs"
            variant="default"
            leftSection={<IconWand size={14} />}
            onClick={() => polish.polish(task)}
            loading={polish.isPending}
            disabled={polishing}
          >
            Polish prompt
          </Button>
        </Group>
      )}
    </>
  );
  return commentShell(c, header, 'Add to the thread');
}

function proposalInTodoShell(c: ShellContext): Shell {
  const { task, actions } = c;
  const header = (
    <Alert color="grape" variant="light" icon={<IconSparkles size={18} />} title="Proposed by an agent">
      <Stack gap="xs">
        <Text size="sm">
          The board put this proposal in Todo, but no worker runs a task an agent proposed, so it will not run from
          here. To start it yourself, move it to Backlog and then to Todo again: you will see its whole prompt before it
          starts as yours.
        </Text>
        <Group justify="flex-end">
          <Button size="xs" variant="default" onClick={() => actions.close.mutate({ id: task.id, closed: true })}>
            Discard
          </Button>
        </Group>
      </Stack>
    </Alert>
  );
  return commentShell(c, header, 'Add to the thread');
}

function todoShell(c: ShellContext): Shell {
  const { task, actions, waiting } = c;
  const header = (
    <>
      {waiting && task.notBefore !== null && (
        <Group justify="space-between" wrap="nowrap">
          <Text size="sm">
            Delayed until {stamp(task.notBefore)}.
            {task.scheduleId !== null && (
              <>
                {' '}
                This is the next run of a repeating schedule (
                <Anchor component={Link} to="/schedules" size="sm">
                  Schedules
                </Anchor>
                ).
              </>
            )}
          </Text>
          <Button
            size="xs"
            leftSection={<IconPlayerPlay size={14} />}
            onClick={() => actions.setNotBefore.mutate({ id: task.id, notBefore: null })}
            loading={actions.setNotBefore.isPending}
          >
            Run now
          </Button>
        </Group>
      )}
      <Group justify="space-between" wrap="nowrap">
        <Text size="sm">
          {task.paused ? 'Paused to free its slot.' : task.woken ? 'Its wait is over.' : 'Queued.'}{' '}
          {task.next === 'resume'
            ? `The next run resumes the agent's session${task.machine ? ` on ${task.machine}` : ''}${task.woken ? '' : ' with your reply'}.`
            : 'The next free worker starts it.'}
        </Text>
        <StopButton task={task} actions={actions} />
      </Group>
    </>
  );
  return commentShell(c, header, 'Add to the thread before it starts');
}

function replyShell(c: ShellContext): Shell {
  const { task, thread, actions, message, setMessage, isProposal } = c;
  const suggestion = isProposal || task.status !== 'needs-me' ? undefined : currentSuggestion(thread);
  const sendMessage = (text: string) => {
    if (!text.trim() || isProposal || actions.reply.isPending) return;
    actions.reply.mutate({ id: task.id, message: text, resume: true }, { onSuccess: () => setMessage('') });
  };
  const send = () => sendMessage(message);
  const confirmRerun = () =>
    modals.openConfirmModal({
      title: 'Re-run from scratch?',
      children: (
        <Text size="sm">The next run starts a new session and does not see the earlier one, only this thread.</Text>
      ),
      labels: { confirm: 'Re-run', cancel: 'Cancel' },
      onConfirm: () => actions.rerun.mutate({ id: task.id }),
    });
  return {
    minRows: 3,
    onSubmit: send,
    suggestion,
    skills: c.skills,
    placeholder: task.sessionId
      ? 'Steer the agent: a follow-up, a correction, a new instruction…'
      : 'Instructions for the run…',
    header: (
      <>
        {task.status === 'waiting' && (
          <Group justify="space-between" wrap="nowrap">
            <Text size="sm">
              {task.waitCheck ? `Waiting for a check on ${task.machine ?? 'its machine'} to pass` : 'Waiting'}
              {task.wakeAt !== null
                ? `${task.waitCheck ? ', at the latest until' : ' until'} ${stamp(task.wakeAt)}`
                : ''}
              . Its slot is free; then it resumes the agent’s session. Send & continue ends the wait with your reply.
            </Text>
            <Group gap="xs" wrap="nowrap">
              <StopButton task={task} actions={actions} />
              <Button
                size="xs"
                leftSection={<IconAlarm size={14} />}
                onClick={() => actions.wakeNow.mutate({ id: task.id })}
                loading={actions.wakeNow.isPending}
              >
                Wake now
              </Button>
            </Group>
          </Group>
        )}
        {isProposal && (
          <Alert color="grape" variant="light" icon={<IconSparkles size={18} />} title="Proposed by an agent">
            <Group justify="space-between">
              <Text size="sm">Nothing runs until you start it.</Text>
              <Group gap="xs">
                <Button
                  size="xs"
                  color="grape"
                  leftSection={<IconPlayerPlay size={14} />}
                  onClick={() =>
                    confirmStart(task, (sent) => actions.move.mutate({ id: task.id, status: 'todo', task: sent }))
                  }
                  loading={actions.move.isPending}
                >
                  Start
                </Button>
                <Button size="xs" variant="default" onClick={() => actions.close.mutate({ id: task.id, closed: true })}>
                  Discard
                </Button>
              </Group>
            </Group>
          </Alert>
        )}
        {suggestion !== undefined && message === '' && (
          <Group gap="sm" wrap="nowrap" data-testid="suggested-reply">
            <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
              Suggested reply
            </Text>
            <Text size="sm" style={{ flex: 1, minWidth: 0, whiteSpace: 'pre-wrap' }}>
              {suggestion}
            </Text>
            <Button size="compact-sm" variant="default" onClick={() => setMessage(suggestion)}>
              Use
            </Button>
            <Button
              size="compact-sm"
              onClick={() => sendMessage(suggestion)}
              loading={actions.reply.isPending}
              aria-label="Send suggested reply"
            >
              Send
            </Button>
          </Group>
        )}
      </>
    ),
    footer: (
      <Group justify="space-between" wrap="wrap">
        <Group gap="xs">
          <Button
            variant="default"
            leftSection={<IconCheck size={16} />}
            onClick={() => actions.done.mutate({ id: task.id })}
            disabled={task.status === 'done'}
            loading={actions.done.isPending}
          >
            Mark done
          </Button>
          <Menu position="top-start">
            <Menu.Target>
              <Button variant="subtle" color="gray" rightSection={<IconChevronDown size={14} />}>
                More
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<IconRefresh size={14} />} onClick={confirmRerun} disabled={isProposal}>
                Re-run fresh
              </Menu.Item>
              <Menu.Item
                leftSection={<IconMessage size={14} />}
                disabled={!message.trim()}
                onClick={() =>
                  actions.reply.mutate({ id: task.id, message, resume: false }, { onSuccess: () => setMessage('') })
                }
              >
                Comment without continuing
              </Menu.Item>
              <Menu.Item
                leftSection={<IconInbox size={14} />}
                onClick={() => actions.move.mutate({ id: task.id, status: 'backlog', task })}
              >
                Move to Backlog
              </Menu.Item>
              <Menu.Item
                leftSection={<IconArchive size={14} />}
                color="red"
                onClick={() => actions.close.mutate({ id: task.id, closed: true })}
              >
                Close
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
        <Group gap="xs">
          <Text size="xs" c="dimmed" visibleFrom="sm">
            <Kbd size="xs">⌘</Kbd>+<Kbd size="xs">Enter</Kbd>
          </Text>
          <Button
            leftSection={<IconPlayerPlay size={16} />}
            onClick={send}
            disabled={!message.trim() || isProposal}
            loading={actions.reply.isPending}
            title={isProposal ? 'Start the proposal first' : undefined}
          >
            {task.sessionId ? 'Send & continue' : 'Send & run'}
          </Button>
        </Group>
      </Group>
    ),
  };
}

/**
 * What you can do with the task now, as explicit buttons: answer the agent's question, send it a follow-up,
 * finish it, start it over, or start a proposal.
 */
export function ActionPanel({
  task,
  thread,
  followUps,
  skills,
}: {
  task: BoardTask;
  thread: ThreadNote[];
  followUps: BoardTask[];
  /** What a reply may start with after a `/`: the skills of the task's machine and directory. */
  skills?: readonly CatalogSkill[];
}) {
  const actions = useActions(task.id);
  const polish = usePolish();
  const polishing = followUps.some((child) => isOpenPolishOf(child, task.id));
  const now = useNow(30_000);
  const runNow = useNow(5_000);
  const waiting = startsIn(task.notBefore, now) !== undefined;
  const [stopClickedAt, setStopClickedAt] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [replyFocused, setReplyFocused] = useState(false);
  const [handover, setHandover] = useState<{ text: string; focus: boolean } | null>(null);
  const openQuestion = openQuestionOf(task, thread);
  // An agent's proposal: only starting it, which seals its prompt again as yours, lets a worker run it.
  const isProposal = task.createdBy === 'agent';
  // A proposal waits for the user to start it, even with a question on it: its alert comes first.
  const asking = !task.closed && openQuestion?.questions !== undefined && !isProposal;
  const moveToTodo = () =>
    moveConfirmed(task, 'todo', (sent) => actions.move.mutate({ id: task.id, status: 'todo', task: sent }));

  if (asking && message !== '') {
    setHandover({ text: message, focus: replyFocused });
    setMessage('');
  } else if (!asking && handover !== null) {
    setHandover(null);
  }

  if (task.closed) {
    return (
      <Paper withBorder p="md">
        <Group justify="space-between">
          <Text size="sm" c="dimmed">
            This task is closed. Workers ignore it.
          </Text>
          <Button
            variant="default"
            leftSection={<IconArchiveOff size={16} />}
            onClick={() => actions.close.mutate({ id: task.id, closed: false })}
          >
            Reopen
          </Button>
        </Group>
      </Paper>
    );
  }

  if (asking && openQuestion?.questions) {
    return (
      <QuestionPanel
        key={openQuestion.id}
        questions={openQuestion.questions}
        submitting={actions.answer.isPending}
        onSubmit={(questions, answers, note) =>
          actions.answer.mutate({ id: task.id, questionNoteId: openQuestion.id, questions, answers, message: note })
        }
        dismissing={actions.dismissQuestion.isPending}
        onDismiss={() => actions.dismissQuestion.mutate({ id: task.id, questionNoteId: openQuestion.id })}
        handover={handover?.text}
        focusNote={handover?.focus}
      />
    );
  }

  const context: ShellContext = {
    task,
    thread,
    actions,
    message,
    setMessage,
    skills,
    isProposal,
    polishing,
    polish,
    waiting,
    stopClickedAt,
    setStopClickedAt,
    now: runNow,
  };
  const shell =
    task.status === 'running'
      ? runningShell(context)
      : task.status === 'backlog'
        ? backlogShell(context, moveToTodo)
        : task.status === 'todo' && isProposal
          ? proposalInTodoShell(context)
          : task.status === 'todo'
            ? todoShell(context)
            : replyShell(context);

  return <Composer shell={shell} message={message} setMessage={setMessage} onFocusChange={setReplyFocused} />;
}
