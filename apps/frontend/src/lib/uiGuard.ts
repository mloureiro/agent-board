import type { AppRouter } from '@agent-board/backend/router';
import { isUiPath } from '@agent-board/shared/ui';
import { TRPCClientError, type TRPCLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';

/** Fails an operation on a path the declared UI API does not list, so the bundled frontend cannot call outside it. */
export const uiGuardLink: TRPCLink<AppRouter> = () => {
  return ({ op, next }) => {
    if (isUiPath(op.path)) return next(op);
    return observable((observer) => {
      observer.error(new TRPCClientError(`${op.path} is not a procedure of the UI API`));
    });
  };
};
