import { initTRPC, TRPCError } from '@trpc/server';
import { ZodError } from 'zod';
import type { Config } from '../config';
import type { Db, Tx } from '../db/client';
import { appUsers } from '../db/schema';
import { withOwner } from '../db/scope';
import type { AuthLog } from '../services/auth/env';
import type { OidcClient } from '../services/auth/oidc';
import type { Changes } from '../services/changes';
import { AppError } from '../services/errors';

export interface Context {
  /** The pool handle; procedures use `ctx.db`, the request's transaction. */
  root: Db;
  config: Config;
  changes: Changes;
  log: AuthLog;
  oidc: OidcClient;
  /** Who is using the UI: the no-login user or the owner of the session token; null when nobody is signed in. */
  username: string | null;
  /** The sha256 of the session token this request came with, if it came with a live one. */
  sessionHash: string | null;
  /** Sends the browser the session cookie for a token, or with null removes it; does nothing on a board without login. */
  setSessionCookie: (token: string | null) => void;
}

const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: { ...shape.data, zodIssues: error.cause instanceof ZodError ? error.cause.issues : null },
    };
  },
});

export const router = t.router;

const mapErrors = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok && result.error.cause instanceof AppError) {
    const cause = result.error.cause;
    throw new TRPCError({
      code: cause.code === 'UNPROCESSABLE' ? 'UNPROCESSABLE_CONTENT' : cause.code,
      message: cause.message,
      cause,
    });
  }
  return result;
});

/** Carries a failed procedure's result out of the transaction, which only rolls back on a throw. */
class Rollback<R> extends Error {
  constructor(readonly result: R) {
    super('procedure failed');
  }
}

/** Keys and machines do not change what dispatch decides; a feed request is applied by a dispatch tick; an import brings tasks, schedules and machines at once. */
const changesDispatch = (path: string): boolean =>
  path.startsWith('tasks.') || path.startsWith('schedules.') || path.startsWith('feeds.') || path === 'account.import';

/** Refuses a request nobody is signed in for, then runs the rest of the procedure in one transaction scoped to the user, exposed as `ctx.db`. */
const scoped = t.middleware(async ({ ctx, next, path, type }) => {
  const { username } = ctx;
  if (username === null) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in to use the board.' });
  const run = (db: Tx) => next({ ctx: { db, root: undefined, username } });
  try {
    const result = await withOwner(ctx.root, username, async (db) => {
      // A signed-in user's row exists because their session does; only the login-less board creates it here, with no
      // source, and only on a mutation, so that a browser still polling after `account.delete` does not bring the user back.
      if (!ctx.config.auth.login && type === 'mutation') {
        await db.insert(appUsers).values({ username }).onConflictDoNothing();
      }
      const result = await run(db);
      if (!result.ok) throw new Rollback(result);
      return result;
    });
    if (type === 'mutation' && changesDispatch(path)) ctx.changes.notify(username);
    if (type === 'mutation' && path === 'account.delete') ctx.changes.endStreams(username);
    return result;
  } catch (error) {
    if (error instanceof Rollback) return error.result as Awaited<ReturnType<typeof run>>;
    throw error;
  }
});

/** Needs a signed-in user and runs in a transaction scoped to them (`ctx.db`). */
export const procedure = t.procedure.use(mapErrors).use(scoped);

/** Reachable without signing in: the sign-in itself. It gets `ctx.root`, not a scoped transaction. */
export const publicProcedure = t.procedure.use(mapErrors);
