import type { CatalogSkill } from '@agent-board/shared';
import { Combobox, Group, Paper, Tabs, Text, Textarea, useCombobox } from '@mantine/core';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react';
import { acceptSkill, matchSkills, skillCompletion } from '../lib/catalog';
import { Markdown } from './Markdown';

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minRows?: number;
  maxRows?: number;
  /** ⌘/Ctrl+Enter. */
  onSubmit?: () => void;
  autoFocus?: boolean;
  label?: string;
  /** Shown as ghost text while the editor is empty; Tab then fills it in. */
  suggestion?: string;
  /** The skills offered while the first word of the text is being typed after a `/`. Advice: any name can still be typed. */
  skills?: readonly CatalogSkill[];
}

/** Markdown with a preview tab; ⌘/Ctrl+Enter submits. */
export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  minRows = 3,
  maxRows = 18,
  onSubmit,
  autoFocus,
  label,
  suggestion,
  skills = [],
}: Props) {
  const [tab, setTab] = useState<string | null>('write');
  const field = useRef<HTMLTextAreaElement>(null);
  const caretAfter = useRef<number | null>(null);
  const listId = useId();
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  // The first token Escape closed the list for, and the option picked with the arrows for one query.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [picked, setPicked] = useState({ query: '', index: 0 });

  const completion = skillCompletion(value, caret);
  const matches = completion === undefined ? [] : matchSkills(skills, completion.query);
  const token = completion === undefined ? null : value.slice(0, completion.tokenEnd);
  const open = focused && matches.length > 0 && token !== dismissed;
  const active =
    completion !== undefined && picked.query === completion.query ? Math.min(picked.index, matches.length - 1) : 0;
  const combobox = useCombobox({ opened: open });
  const optionId = (index: number): string => `${listId}-skill-${index}`;

  useEffect(() => {
    const element = field.current;
    if (!autoFocus || element === null) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, [autoFocus]);

  // The caret can only be placed once the new text is in the field.
  useEffect(() => {
    if (caretAfter.current === null) return;
    field.current?.setSelectionRange(caretAfter.current, caretAfter.current);
    caretAfter.current = null;
  }, [value]);

  const readCaret = (event: SyntheticEvent<HTMLTextAreaElement>) => setCaret(event.currentTarget.selectionStart);

  const accept = (name: string) => {
    if (completion === undefined) return;
    const next = acceptSkill(value, completion.tokenEnd, name);
    setCaret(next.caret);
    // The effect below runs on a change of the value, and an accept that changes nothing is none.
    if (next.text === value) field.current?.setSelectionRange(next.caret, next.caret);
    else caretAfter.current = next.caret;
    onChange(next.text);
  };

  const move = (to: number) =>
    setPicked({ query: completion?.query ?? '', index: (to + matches.length) % matches.length });

  const onKeyDown = (event: KeyboardEvent) => {
    if (open && completion !== undefined && !event.nativeEvent.isComposing) {
      const plainEnter = event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.shiftKey;
      const plainTab = event.key === 'Tab' && !event.shiftKey;
      const name = matches[active]?.name;
      if ((plainEnter || plainTab) && name !== undefined) {
        event.preventDefault();
        accept(name);
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        move(active + (event.key === 'ArrowDown' ? 1 : -1));
        return;
      }
      if (event.key === 'Escape') {
        setDismissed(token);
        return;
      }
    }
    if (suggestion !== undefined && value === '' && event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault();
      onChange(suggestion);
      return;
    }
    if (onSubmit && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSubmit();
    }
  };
  return (
    <div>
      {label && (
        <Text size="sm" fw={500} mb={4}>
          {label}
        </Text>
      )}
      <Tabs value={tab} onChange={setTab} variant="outline" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="write" size="xs">
            Write
          </Tabs.Tab>
          <Tabs.Tab value="preview" disabled={value.trim() === ''}>
            Preview
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="write" pt="xs">
          <Combobox store={combobox} onOptionSubmit={accept} transitionProps={{ duration: 0 }}>
            <Combobox.Target withKeyboardNavigation={false} aria-activedescendant={open ? optionId(active) : undefined}>
              <Textarea
                ref={field}
                value={value}
                onChange={(event) => {
                  readCaret(event);
                  onChange(event.currentTarget.value);
                }}
                placeholder={value === '' ? (suggestion ?? placeholder) : placeholder}
                autosize
                minRows={minRows}
                maxRows={maxRows}
                onKeyDown={onKeyDown}
                onKeyUp={readCaret}
                onSelect={readCaret}
                onClick={readCaret}
                onFocus={(event) => {
                  readCaret(event);
                  setFocused(true);
                }}
                onBlur={() => setFocused(false)}
                styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 13 } }}
              />
            </Combobox.Target>
            <Combobox.Dropdown>
              <Combobox.Options aria-label="Skills">
                {matches.map((skill, index) => (
                  <Combobox.Option
                    key={skill.name}
                    value={skill.name}
                    id={optionId(index)}
                    selected={index === active}
                    aria-selected={index === active}
                    onMouseEnter={() => move(index)}
                  >
                    <Group gap="xs" wrap="nowrap">
                      <Text span size="sm" ff="monospace">
                        /{skill.name}
                      </Text>
                      {skill.argumentHint !== undefined && (
                        <Text span size="xs" c="dimmed" truncate>
                          {skill.argumentHint}
                        </Text>
                      )}
                    </Group>
                    {skill.description !== undefined && (
                      <Text size="xs" c="dimmed" truncate>
                        {skill.description}
                      </Text>
                    )}
                  </Combobox.Option>
                ))}
              </Combobox.Options>
            </Combobox.Dropdown>
          </Combobox>
        </Tabs.Panel>
        <Tabs.Panel value="preview" pt="xs">
          <Paper withBorder p="sm" mih={80}>
            <Markdown>{value}</Markdown>
          </Paper>
        </Tabs.Panel>
      </Tabs>
    </div>
  );
}
