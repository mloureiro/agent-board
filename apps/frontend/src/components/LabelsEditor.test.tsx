import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { labelSuggestions, LabelsInput } from './LabelsEditor';

const renderInput = (value: string[]) => {
  const onChange = vi.fn();
  render(
    <MantineProvider>
      <LabelsInput value={value} onChange={onChange} />
    </MantineProvider>,
  );
  return { onChange, input: screen.getByRole('combobox', { name: 'Labels' }) };
};

describe('LabelsInput', () => {
  it('passes on the whole list when a label is added, without repeats', async () => {
    const { onChange, input } = renderInput(['bug']);
    await userEvent.type(input, 'ui{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(['bug', 'ui']);
  });

  it('shows why a label is refused and passes nothing on', async () => {
    const { onChange, input } = renderInput(['bug']);
    await userEvent.type(input, '-x{Enter}');
    expect(await screen.findByText(/not a label/)).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('labelSuggestions', () => {
  it('lists every label once, the most used first', () => {
    expect(labelSuggestions([{ labels: ['b', 'a'] }, { labels: ['a'] }, { labels: [] }])).toEqual(['a', 'b']);
  });
});
