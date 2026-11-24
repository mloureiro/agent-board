import type { Status } from '@agent-board/shared';
import { Alert, Button, Group, Text, Textarea } from '@mantine/core';
import { modals } from '@mantine/modals';
import type { DraftStore } from '../lib/drafts';
import { proposalSlot } from '../lib/drafts';
import { useDraftIn } from '../lib/draftsContext';
import { startsProposal, type Proposal } from '@agent-board/shared/ui';

const TITLE = 'Start this agent’s proposal as yours?';

function StartProposal({
  proposal,
  drafts,
  close,
  onStart,
}: {
  proposal: Proposal;
  drafts: DraftStore | null;
  close: () => void;
  onStart: (input: string) => void;
}) {
  const [input, setInput, clearInput] = useDraftIn(drafts, proposalSlot(proposal));
  return (
    <>
      <Text size="sm" mb="xs">
        A worker will run this prompt as if you had written it, with your permissions. Read all of it first, and change
        it here if it is not what you want run.
      </Text>
      <Textarea
        data-testid="proposal-prompt"
        aria-label="Prompt"
        value={input}
        onChange={(event) => setInput(event.currentTarget.value)}
        autosize
        minRows={4}
        maxRows={20}
        styles={{
          input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 'var(--mantine-font-size-sm)' },
        }}
      />
      <Group justify="flex-end" mt="md">
        <Button
          variant="default"
          onClick={() => {
            clearInput();
            close();
          }}
        >
          Cancel
        </Button>
        <Button
          color="grape"
          disabled={input.trim() === ''}
          onClick={() => {
            close();
            onStart(input);
          }}
        >
          Start as mine
        </Button>
      </Group>
    </>
  );
}

/**
 * Asks the user to confirm starting an agent's proposal, showing its whole prompt as plain text that they may edit: starting
 * seals exactly the text they confirm as theirs, and a worker then runs it with their permissions. `onConfirm` gets the
 * proposal with that text as its prompt.
 */
export function confirmStart(
  proposal: Proposal,
  drafts: DraftStore | null,
  onConfirm: (proposal: Proposal) => void,
): void {
  if (proposal.unreadable.includes('input')) {
    modals.openConfirmModal({
      title: TITLE,
      size: 'lg',
      children: <Alert color="red">This proposal’s prompt cannot be read, so it cannot be started here.</Alert>,
      labels: { confirm: 'Start as mine', cancel: 'Cancel' },
      confirmProps: { color: 'grape', disabled: true },
    });
    return;
  }
  const id: string = modals.open({
    title: TITLE,
    size: 'lg',
    children: (
      <StartProposal
        proposal={proposal}
        drafts={drafts}
        close={() => modals.close(id)}
        onStart={(input) => onConfirm({ ...proposal, input })}
      />
    ),
  });
}

/**
 * Runs `move` with the proposal as it should be sent: after a confirmation that shows (and lets the user edit) the prompt when
 * the move starts an agent's proposal, else at once and unchanged.
 */
export function moveConfirmed(
  proposal: Proposal,
  to: Status,
  drafts: DraftStore | null,
  move: (proposal: Proposal) => void,
): void {
  if (startsProposal(proposal, to)) confirmStart(proposal, drafts, move);
  else move(proposal);
}
