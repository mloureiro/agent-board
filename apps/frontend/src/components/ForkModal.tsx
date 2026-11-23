import { Alert, Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { forkSlot } from '../lib/drafts';
import { useDraft } from '../lib/draftsContext';
import { forkProblem } from '../lib/sealing';
import { errorMessage, useTRPC, type BoardTask } from '../lib/trpc';
import { MarkdownEditor } from './MarkdownEditor';

interface Props {
  opened: boolean;
  onClose: () => void;
  /** The task to fork, as its page shows it. */
  parent: BoardTask;
}

/** Side work with the context of a task: a new task whose first run continues a copy of this task's Claude session. */
export function ForkModal({ opened, onClose, parent }: Props) {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const [{ title, input }, setText, clearText] = useDraft(forkSlot(parent));
  const fork = useMutation(trpc.tasks.fork.mutationOptions());
  const problem = forkProblem(parent);
  const ready = input.trim() !== '' && problem === undefined;

  const submit = () => {
    if (!ready || fork.isPending) return;
    fork.mutate(
      { parent, title, input },
      {
        onSuccess: (task) => {
          clearText();
          onClose();
          navigate(`/t/${task.id}`);
        },
      },
    );
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Fork this task" size="lg">
      <Stack>
        <Text size="sm" c="dimmed">
          A new task continues a copy of this task&apos;s Claude session
          {parent.machine === null ? '' : ` on ${parent.machine}`}, in the same directory, with the same agent, model
          and effort. This task stays as it is, also while it runs: the copy is the session as it was last written.
        </Text>
        {problem !== undefined && (
          <Alert color="orange" variant="light">
            {problem}
          </Alert>
        )}
        <MarkdownEditor
          label="Instructions"
          value={input}
          onChange={(next) => setText({ title, input: next })}
          minRows={6}
          onSubmit={submit}
          autoFocus
          placeholder="What the fork should do, as you would tell it in the conversation"
        />
        <TextInput
          label="Title"
          value={title}
          onChange={(event) => setText({ title: event.currentTarget.value, input })}
        />
        {fork.error && (
          <Text size="sm" c="red">
            {errorMessage(fork.error)}
          </Text>
        )}
        <Group justify="flex-end">
          <Button onClick={submit} disabled={!ready} loading={fork.isPending}>
            Fork &amp; start
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
