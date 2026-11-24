import { z } from 'zod';
import { loginOf, type AuthEnv } from '../services/auth/env';
import { CHALLENGE, VERIFIER } from '../services/auth/flows';
import { approveHandoff, describeHandoff, finishHandoff, startHandoff } from '../services/auth/handoff';
import { finishOidc, startOidc } from '../services/auth/oidc';
import {
  listPasskeys,
  loginOptions,
  loginWithPasskey,
  registerOptions,
  registerPasskey,
  removePasskey,
  renamePasskey,
  signupOptions,
  signupWithPasskey,
} from '../services/auth/passkeys';
import { finishSaml, startSaml } from '../services/auth/saml';
import { deleteSession } from '../services/auth/sessions';
import { authenticationResponse, registrationResponse } from '../services/auth/webauthnSchemas';
import { procedure, publicProcedure, router, type Context } from './trpc';

const authEnv = (ctx: Pick<Context, 'root' | 'config' | 'log' | 'oidc'>): AuthEnv => ({
  root: ctx.root,
  login: loginOf(ctx.config),
  log: ctx.log,
  oidc: ctx.oidc,
});

/** Hands the browser the new session as a cookie; the token is in no response body. */
function signedIn(ctx: Pick<Context, 'setSessionCookie'>, token: string): { ok: true } {
  ctx.setSessionCookie(token);
  return { ok: true };
}

const challenge = z.string().regex(CHALLENGE);
const verifier = z.string().regex(VERIFIER);
const flow = z.string().max(128);
const passkeyId = z.string().min(1).max(1024);
const passkeyName = z.string().max(200);

const oidcRouter = router({
  start: publicProcedure
    .input(z.object({ challenge }))
    .mutation(({ ctx, input }) => startOidc(authEnv(ctx), input.challenge)),
  finish: publicProcedure
    .input(z.object({ code: z.string().min(1).max(4096), state: flow, verifier, iss: z.string().max(2048).optional() }))
    .mutation(async ({ ctx, input }) => signedIn(ctx, await finishOidc(authEnv(ctx), input))),
});

const samlRouter = router({
  start: publicProcedure
    .input(z.object({ challenge }))
    .mutation(({ ctx, input }) => startSaml(authEnv(ctx), input.challenge)),
  finish: publicProcedure
    .input(z.object({ flow, verifier }))
    .mutation(async ({ ctx, input }) => signedIn(ctx, await finishSaml(authEnv(ctx), input))),
});

const handoffRouter = router({
  start: publicProcedure
    .input(z.object({ challenge }))
    .mutation(({ ctx, input }) => startHandoff(authEnv(ctx), input.challenge)),
  describe: procedure.input(z.object({ flow })).query(({ ctx, input }) => describeHandoff(ctx.db, input.flow)),
  approve: procedure
    .input(z.object({ flow }))
    .mutation(({ ctx, input }) =>
      approveHandoff(ctx.db, { username: ctx.username, sessionHash: ctx.sessionHash }, input.flow),
    ),
  finish: publicProcedure.input(z.object({ flow, verifier })).mutation(async ({ ctx, input }) => {
    const result = await finishHandoff(authEnv(ctx), input);
    if (result === 'pending') return { status: 'pending' as const };
    ctx.setSessionCookie(result);
    return { status: 'signed-in' as const };
  }),
});

const passkeyRouter = router({
  loginOptions: publicProcedure.mutation(({ ctx }) => loginOptions(authEnv(ctx))),
  login: publicProcedure
    .input(z.object({ flow, response: authenticationResponse }))
    .mutation(async ({ ctx, input }) => signedIn(ctx, await loginWithPasskey(authEnv(ctx), input))),
  signupOptions: publicProcedure
    .input(z.object({ username: z.string().max(200), signupToken: z.string().max(1024) }))
    .mutation(({ ctx, input }) => signupOptions(authEnv(ctx), input)),
  signup: publicProcedure
    .input(z.object({ flow, response: registrationResponse, name: passkeyName.optional() }))
    .mutation(async ({ ctx, input }) => signedIn(ctx, await signupWithPasskey(authEnv(ctx), input))),
});

export const authRouter = router({
  /** What the sign-in page offers; `{ login: false }` when the board runs without login. */
  config: publicProcedure.query(({ ctx }) => {
    const { auth } = ctx.config;
    if (!auth.login) return { login: false as const };
    return {
      login: true as const,
      passkeys: auth.passkeys,
      signup: auth.passkeys && auth.signupToken !== null,
      oidc: auth.oidc && { label: auth.oidc.label },
      saml: auth.saml && { label: auth.saml.label },
    };
  }),
  logout: procedure.mutation(async ({ ctx }) => {
    if (ctx.sessionHash) await deleteSession(ctx.db, ctx.sessionHash);
    ctx.setSessionCookie(null);
  }),
  oidc: oidcRouter,
  saml: samlRouter,
  passkey: passkeyRouter,
  handoff: handoffRouter,
});

/** The signed-in user's own passkeys. */
export const passkeysRouter = router({
  list: procedure.query(({ ctx }) => listPasskeys(ctx.db)),
  registerOptions: procedure.mutation(({ ctx }) => registerOptions(ctx.db, loginOf(ctx.config), ctx.username)),
  register: procedure
    .input(z.object({ flow, response: registrationResponse, name: passkeyName }))
    .mutation(({ ctx, input }) => registerPasskey(ctx.db, loginOf(ctx.config), ctx.username, input)),
  rename: procedure
    .input(z.object({ id: passkeyId, name: passkeyName }))
    .mutation(({ ctx, input }) => renamePasskey(ctx.db, input.id, input.name)),
  remove: procedure.input(z.object({ id: passkeyId })).mutation(({ ctx, input }) => removePasskey(ctx.db, input.id)),
});
