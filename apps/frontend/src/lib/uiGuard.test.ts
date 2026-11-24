import { createTRPCClient, type TRPCLink } from '@trpc/client';
import type { AppRouter } from '@agent-board/backend/router';
import { observable } from '@trpc/server/observable';
import { describe, expect, it } from 'vitest';
import { uiGuardLink } from './uiGuard';

function clientWith(seen: string[]) {
  const terminal: TRPCLink<AppRouter> = () => {
    return ({ op }) =>
      observable((observer) => {
        seen.push(op.path);
        observer.next({ result: { type: 'data', data: null }, context: {} });
        observer.complete();
      });
  };
  return createTRPCClient<AppRouter>({ links: [uiGuardLink, terminal] });
}

describe('the UI guard link', () => {
  it('passes a path the UI API lists', async () => {
    const seen: string[] = [];
    await clientWith(seen).me.query();
    expect(seen).toEqual(['me']);
  });

  it('rejects a path it does not list, without sending it', async () => {
    const seen: string[] = [];
    const unknown = (clientWith(seen) as unknown as Record<string, { query: () => Promise<unknown> }>)['nonsense']!;
    await expect(unknown.query()).rejects.toThrow('not a procedure of the UI API');
    expect(seen).toEqual([]);
  });
});
