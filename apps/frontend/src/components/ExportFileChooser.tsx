import type { ExportHeader } from '@agent-board/shared';
import { FileInput, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { readExportHeader } from '@agent-board/shared/ui';
import { errorMessage } from '../lib/trpc';

export interface ChosenExport {
  file: File;
  header: ExportHeader;
}

interface Props {
  /** The file and its header once the header reads, null when there is none or it does not read. */
  onChange: (chosen: ChosenExport | null) => void;
  disabled?: boolean;
}

/** Picks an export file and reads its first line, so a wrong file is named before anything else is asked. */
export function ExportFileChooser({ onChange, disabled = false }: Props) {
  const [error, setError] = useState<string | null>(null);
  const choose = async (file: File | null) => {
    setError(null);
    onChange(null);
    if (file === null) return;
    try {
      onChange({ file, header: await readExportHeader(file) });
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Stack gap={4}>
      <FileInput
        label="Export file"
        placeholder="Choose an .ndjson file"
        accept=".ndjson,application/x-ndjson,application/json,text/plain"
        clearable
        disabled={disabled}
        onChange={(file) => void choose(file)}
        error={error}
      />
      <Text size="xs" c="dimmed">
        The file is read in this browser. Nothing is sent until you confirm.
      </Text>
    </Stack>
  );
}
