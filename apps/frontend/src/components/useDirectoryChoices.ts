import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { Machine } from '@agent-board/shared/ui';
import { useTRPC } from '../lib/trpc';
import { useNow } from '../lib/useNow';
import { directoryChoices, type DirectoryChoices } from '../lib/workingDirectories';

export interface DirectoryChoicesState extends DirectoryChoices {
  machines: UseQueryResult<Machine[]>;
}

/** The directories the machines listed, opened and grouped for a picker: the New task form and the task page offer the same. */
export function useDirectoryChoices(): DirectoryChoicesState {
  const trpc = useTRPC();
  const machines = useQuery(trpc.machines.list.queryOptions());
  const now = useNow(30_000);
  const choices = useMemo(() => directoryChoices(machines.data ?? [], now), [machines.data, now]);
  return useMemo(() => ({ ...choices, machines }), [choices, machines]);
}
