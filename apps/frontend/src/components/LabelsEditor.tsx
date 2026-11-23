import { ActionIcon, Popover, TagsInput } from '@mantine/core';
import { IconTag } from '@tabler/icons-react';
import { checkLabels, ContractError, MAX_LABEL_LENGTH, MAX_LABELS } from '@agent-board/shared';
import { useState, type SyntheticEvent } from 'react';

// A Modal closes on any Escape it sees on window, before the popover can take it, unless the focused element carries this.
const KEEP_ESCAPE = { 'data-mantine-stop-propagation': true } as const;

const stop = (event: SyntheticEvent) => {
  event.preventDefault();
  event.stopPropagation();
};

interface InputProps {
  value: readonly string[];
  onChange: (labels: string[]) => void;
  suggestions?: readonly string[];
  label?: string;
  ariaLabel?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}

export function LabelsInput({ value, onChange, suggestions = [], label, ariaLabel, disabled, autoFocus }: InputProps) {
  const [error, setError] = useState<string | undefined>();
  const change = (next: string[]) => {
    try {
      const labels = checkLabels(next);
      setError(undefined);
      onChange(labels);
    } catch (failure) {
      if (!(failure instanceof ContractError)) throw failure;
      setError(failure.message);
    }
  };
  return (
    <TagsInput
      {...KEEP_ESCAPE}
      label={label}
      aria-label={label === undefined ? (ariaLabel ?? 'Labels') : undefined}
      placeholder={value.length === 0 ? 'Add a label, then Enter' : undefined}
      value={[...value]}
      onChange={change}
      data={suggestions.filter((suggestion) => !value.includes(suggestion))}
      maxTags={MAX_LABELS}
      maxLength={MAX_LABEL_LENGTH}
      error={error}
      disabled={disabled}
      clearable
      acceptValueOnBlur
      data-autofocus={autoFocus || undefined}
      comboboxProps={{ withinPortal: false }}
    />
  );
}

interface EditorProps {
  value: readonly string[];
  onChange: (labels: string[]) => void;
  suggestions?: readonly string[];
  size?: number;
  revealOnHover?: boolean;
  disabled?: boolean;
}

/** A tag button that opens `LabelsInput` in a popover, without following the link of the card it sits on. */
export function LabelsEditor({
  value,
  onChange,
  suggestions,
  size = 14,
  revealOnHover = false,
  disabled,
}: EditorProps) {
  const [opened, setOpened] = useState(false);
  const toggle = (event: SyntheticEvent) => {
    stop(event);
    setOpened(!opened);
  };
  return (
    <Popover opened={opened} onChange={setOpened} position="bottom-start" shadow="md" width={300} trapFocus returnFocus>
      <Popover.Target>
        <ActionIcon
          size={size + 6}
          variant="subtle"
          color="gray"
          className={revealOnHover ? 'labels-add' : undefined}
          data-open={opened || undefined}
          aria-label={value.length === 0 ? 'Add labels' : 'Edit labels'}
          title={value.length === 0 ? 'Add labels' : 'Edit labels'}
          disabled={disabled}
          onClick={toggle}
        >
          <IconTag size={size} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown p="xs" onClick={(event) => event.stopPropagation()}>
        <LabelsInput
          value={value}
          onChange={onChange}
          {...(suggestions === undefined ? {} : { suggestions })}
          {...(disabled === undefined ? {} : { disabled })}
          autoFocus
        />
      </Popover.Dropdown>
    </Popover>
  );
}

export function labelSuggestions(tasks: readonly { labels: readonly string[] }[]): string[] {
  const counts = new Map<string, number>();
  for (const task of tasks) for (const label of task.labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return [...counts.entries()].sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([label]) => label);
}
