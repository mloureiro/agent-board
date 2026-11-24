import { UI_PROCEDURES } from '@agent-board/shared/ui';
import { describe, expect, it } from 'vitest';
import { appRouter } from './router';

describe('the UI procedure list', () => {
  it('names every procedure of the router with its kind, and nothing else', () => {
    const actual = Object.fromEntries(
      Object.entries(appRouter._def.procedures as unknown as Record<string, { _def: { type: string } }>).map(
        ([path, p]) => [path, p._def.type],
      ),
    );
    const declared: Record<string, string> = UI_PROCEDURES;
    const unclassified = Object.keys(actual).filter((path) => !(path in declared));
    const stale = Object.keys(declared).filter((path) => !(path in actual));
    const wrongKind = Object.keys(actual).filter((path) => path in declared && declared[path] !== actual[path]);
    expect({ unclassified, stale, wrongKind }).toEqual({ unclassified: [], stale: [], wrongKind: [] });
  });
});
