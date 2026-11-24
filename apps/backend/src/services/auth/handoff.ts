import { and, eq, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { DbOrTx } from '../../db/client';
import { authFlows, sessions } from '../../db/schema';
import { AppError } from '../errors';
import type { AuthEnv } from './env';
import { challengeOf, consumeFlow, createFlow, FLOW_ID, VERIFIER, type Flow } from './flows';
import { createSession, type SessionMethod } from './sessions';

/** Leaves out 0, O, 1 and I. It has 32 symbols, so a random byte taken modulo 32 is unbiased. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

const METHODS: readonly SessionMethod[] = ['passkey', 'oidc', 'saml'];

const expired = (code: 'NOT_FOUND' | 'UNAUTHORIZED') => new AppError(code, 'This sign-in has expired. Start again.');

const newCode = (): string =>
  Array.from(randomBytes(CODE_LENGTH), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');

const shown = (code: unknown): string => `${String(code).slice(0, 4)}-${String(code).slice(4)}`;

/** A live hand-off flow nobody has approved yet. */
const pending = sql`${authFlows.kind} = 'handoff' and ${authFlows.owner} is null and ${authFlows.expiresAt} > now()`;

export async function startHandoff(env: AuthEnv, challenge: string): Promise<{ flow: string; code: string }> {
  const code = newCode();
  const flow = await createFlow(env.root, { kind: 'handoff', challenge, data: { code } });
  return { flow, code: shown(code) };
}

export async function describeHandoff(tx: DbOrTx, flow: string): Promise<{ code: string }> {
  const [row] = FLOW_ID.test(flow)
    ? await tx
        .select({ data: authFlows.data })
        .from(authFlows)
        .where(and(eq(authFlows.id, flow), pending))
    : [];
  if (!row) throw expired('NOT_FOUND');
  return { code: shown(row.data.code) };
}

/** Marks the flow as approved by `username` with the method of the session doing the approving. */
export async function approveHandoff(
  tx: DbOrTx,
  caller: { username: string; sessionHash: string | null },
  flow: string,
): Promise<{ ok: true }> {
  if (!caller.sessionHash) throw new AppError('FORBIDDEN', 'Approve a sign-in from a signed-in browser.');
  const [session] = await tx
    .select({ method: sessions.method })
    .from(sessions)
    .where(eq(sessions.tokenHash, caller.sessionHash));
  if (!session || !FLOW_ID.test(flow)) throw expired('NOT_FOUND');
  const approved = await tx
    .update(authFlows)
    .set({
      owner: caller.username,
      data: sql`${authFlows.data} || ${JSON.stringify({ method: session.method })}::jsonb`,
    })
    .where(and(eq(authFlows.id, flow), pending))
    .returning({ id: authFlows.id });
  if (approved.length === 0) throw expired('NOT_FOUND');
  return { ok: true };
}

const methodOf = (flow: Flow): SessionMethod => {
  const method = METHODS.find((candidate) => candidate === flow.data.method);
  if (!method) throw expired('UNAUTHORIZED');
  return method;
};

/** `'pending'` while the approval has not come; the session token once it has, and then never again. */
export async function finishHandoff(
  env: AuthEnv,
  input: { flow: string; verifier: string },
): Promise<'pending' | string> {
  if (!FLOW_ID.test(input.flow) || !VERIFIER.test(input.verifier)) throw expired('UNAUTHORIZED');
  const challenge = challengeOf(input.verifier);
  const consumed = await consumeFlow(
    env.root,
    'handoff',
    input.flow,
    sql`${authFlows.owner} is not null and ${authFlows.challenge} = ${challenge}`,
  );
  if (consumed?.owner) return createSession(env, consumed.owner, methodOf(consumed));
  const waiting = await env.root
    .select({ id: authFlows.id })
    .from(authFlows)
    .where(and(eq(authFlows.id, input.flow), eq(authFlows.challenge, challenge), pending));
  if (waiting.length === 0) throw expired('UNAUTHORIZED');
  return 'pending';
}
