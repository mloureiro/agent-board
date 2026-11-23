import { Alert, Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { IconPencil } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import type { CatalogSkill } from '@agent-board/shared';
import { canEditPrompt } from '../lib/editPrompt';
import { promptSlot, type DraftSlot, type TextPair } from '../lib/drafts';
import { useDraft, useDraftStore } from '../lib/draftsContext';
import { errorMessage, useTRPC, type BoardTask } from '../lib/trpc';
import { MarkdownEditor } from './MarkdownEditor';

interface FormProps {
  slot: DraftSlot<TextPair>;
  skills?: readonly CatalogSkill[] | undefined;
  hint?: string | undefined;
  pending: boolean;
  error: unknown;
  onCancel: () => void;
  onSave: (title: string, input: string) => void;
}

function PromptForm({ slot, skills, hint, pending, error, onCancel, onSave }: FormProps) {
  const [draft, setDraft, clearDraft] = useDraft(slot);
  const { title: newTitle, input: newInput } = draft;
  const unchanged = slot.isEmpty(draft);
  const save = () => {
    if (!unchanged && !pending) onSave(newTitle, newInput);
  };
  return (
    <Stack>
      <TextInput
        label="Title"
        value={newTitle}
        onChange={(event) => setDraft({ ...draft, title: event.currentTarget.value })}
      />
      <MarkdownEditor
        label="Prompt"
        value={newInput}
        onChange={(input) => setDraft({ ...draft, input })}
        minRows={8}
        onSubmit={save}
        autoFocus
        {...(skills === undefined ? {} : { skills })}
      />
      {hint !== undefined && (
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      )}
      {error !== null && error !== undefined && (
        <Alert color="red" variant="light" title="Not saved">
          <Text size="sm">{errorMessage(error)}</Text>
        </Alert>
      )}
      <Group justify="flex-end" gap="xs">
        <Button
          variant="default"
          onClick={() => {
            clearDraft();
            onCancel();
          }}
        >
          Cancel
        </Button>
        <Button onClick={save} disabled={unchanged} loading={pending}>
          Save
        </Button>
      </Group>
    </Stack>
  );
}

/**
 * Edits the prompt of a task that has not started. Saving seals the new text as yours in the browser and keeps the old text in
 * a note of the task. Only the button follows the task's state: an open editor stays until it is closed, so a worker that
 * claims the task meanwhile shows up as the server's refusal, with the draft still there.
 */
export function EditTaskPrompt({ task, skills }: { task: BoardTask; skills?: readonly CatalogSkill[] }) {
  const trpc = useTRPC();
  const edit = useMutation(trpc.tasks.edit.mutationOptions());
  const drafts = useDraftStore();
  const [opened, setOpened] = useState(false);
  const close = () => {
    setOpened(false);
    edit.reset();
  };
  return (
    <>
      {canEditPrompt(task) && (
        <Button
          variant="subtle"
          size="compact-xs"
          leftSection={<IconPencil size={12} />}
          title="Change the title and prompt until a worker starts the task"
          onClick={() => setOpened(true)}
        >
          Edit prompt
        </Button>
      )}
      <Modal opened={opened} onClose={close} title="Edit prompt" size="lg">
        <PromptForm
          slot={promptSlot(task)}
          skills={skills}
          hint="What it says now stays in a note on the task."
          pending={edit.isPending}
          error={edit.error}
          onCancel={close}
          onSave={(title, input) =>
            edit.mutate(
              { target: { ...task, agent: task.agent ?? null }, title, input },
              {
                onSuccess: () => {
                  drafts?.clear(promptSlot(task).key);
                  close();
                },
              },
            )
          }
        />
      </Modal>
    </>
  );
}
