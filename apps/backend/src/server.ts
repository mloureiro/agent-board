import { ContractError } from '@agent-board/shared';
import { MIN_UI_CLIENT, parseUiApiHeader, UI_API_HEADER } from '@agent-board/shared/ui';
import { TRPCError } from '@trpc/server';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import Fastify from 'fastify';
import type { Config } from './config';
import type { Db } from './db/client';
import { registerMachineApi, type MachineApiOptions } from './machine-api';
import { registerSamlAcs } from './saml-acs';
import type { AuthEnv } from './services/auth/env';
import { OidcClient } from './services/auth/oidc';
import { SAML_ACS_PATH } from './services/auth/saml';
import { cookieValue, hashToken, sessionCookie, sessionOwner, tokenShaped } from './services/auth/sessions';
import { Changes, CHANGES_DEBOUNCE_MS } from './services/changes';
import { AppError, type AppErrorCode } from './services/errors';
import { appRouter, type AppRouter } from './trpc/router';
import { registerUiEvents } from './ui-events';

declare module 'fastify' {
  interface FastifyRequest {
    /** Who is using the UI; null when nobody is signed in. */
    username: string | null;
    /** The sha256 of the request's session token, when it carries a live one. */
    sessionHash: string | null;
  }
}

function uiClientApiOf(header: string | string[] | undefined): number | null {
  try {
    return parseUiApiHeader(header);
  } catch (error) {
    if (error instanceof ContractError) throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
    throw error;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const STATUS: Record<AppErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
};

export interface ServerOptions extends Partial<MachineApiOptions> {
  /** How long writes of one owner are held back to give one event; tests shorten it. */
  debounceMs?: number;
  /** Tests hand in their own to look at it. */
  changes?: Changes;
  /** Lets OIDC talk to an http issuer, for a test's fake one. Never read from the environment. */
  allowInsecureOidc?: boolean;
  /** The lowest UI API version the server accepts, for a test that needs a client below it. Never read from the environment. */
  minUiClient?: number;
}

export async function buildServer(config: Config, root: Db, options: ServerOptions = {}) {
  const changes = options.changes ?? new Changes(options.debounceMs ?? CHANGES_DEBOUNCE_MS);
  const app = Fastify({
    logger: config.nodeEnv === 'test' ? false : { level: 'info' },
    // The machine API sets its own limits per route; this is the UI's.
    bodyLimit: 16 * 1024 * 1024,
    // A batched tRPC request names every procedure in one path segment, and the router refuses a segment over 100 characters.
    maxParamLength: 2048,
    // Behind Caddy or the ingress: makes req.ip, which the request log writes as remoteAddress, the client's address, not the proxy's.
    trustProxy: true,
  });

  const oidc = new OidcClient(config.auth.login ? config.auth.oidc : null, {
    allowInsecure: options.allowInsecureOidc === true && config.nodeEnv !== 'production',
  });

  app.decorateRequest('username', null);
  app.decorateRequest('sessionHash', null);
  app.addHook('onClose', async () => changes.close());
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(STATUS[err.code]).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    // Fastify's own 4xx (bad JSON, a too large body) are the client's fault; error is kept for server faults.
    if (status < 500) app.log.warn(err);
    else app.log.error(err);
    return reply.status(status).send({ error: status === 500 ? 'internal error' : (err as Error).message });
  });

  app.get('/healthz', async () => ({ ok: true }));

  // First, so that it also covers the public sign-in mutations. tRPC's Fastify adapter takes multipart bodies, which a plain
  // HTML form on a sibling subdomain can send with the session cookie: SameSite does not stop a same-site request. Only
  // the JSON the board's own client sends gets through; a cross-origin JSON POST needs a CORS preflight, which this server never grants. The check goes by the matched route,
  // not the raw URL: Fastify routes on the decoded path, so `/%74rpc/...` reaches tRPC too.
  app.addHook('onRequest', async (req, reply) => {
    const route = req.routeOptions.url ?? '';
    if (!(route === '/trpc' || route.startsWith('/trpc/')) || SAFE_METHODS.has(req.method)) return;
    const mediaType = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    if (mediaType !== 'application/json')
      return reply.status(415).send({ error: 'the board takes application/json only' });
  });

  // The machine API has its own tokens and the SAML ACS is the IdP's browser post; everything else may carry a session cookie.
  // A request without one is not turned away here: tRPC answers UNAUTHORIZED for what needs a user.
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (path === '/healthz' || path?.startsWith('/api/machine/') || path === SAML_ACS_PATH) return;
    if (!config.auth.login) {
      req.username = config.auth.user;
      return;
    }
    const sent = cookieValue(req.headers.cookie, config.auth);
    const token = tokenShaped(sent);
    req.username = token ? await sessionOwner(root, config.auth, token) : null;
    if (req.username && token) req.sessionHash = hashToken(token);
    // A cookie the server does not know is dead weight the browser keeps sending.
    if (sent !== null && req.username === null) reply.header('set-cookie', sessionCookie(config.auth, null));
  });

  const pingMs = options.pingMs ?? 25_000;
  registerMachineApi(app, root, config, changes, {
    pingMs,
    ...(options.vocabulary === undefined ? {} : { vocabulary: options.vocabulary }),
  });

  registerUiEvents(app, root, config, changes, pingMs);

  if (config.auth.login && config.auth.saml) {
    const env: AuthEnv = { root, login: config.auth, log: app.log, oidc };
    await registerSamlAcs(app, env);
  }

  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: ({ req, res }) => ({
        uiClientApi: uiClientApiOf(req.headers[UI_API_HEADER]),
        minUiClient: options.minUiClient ?? MIN_UI_CLIENT,
        root,
        config,
        changes,
        log: app.log,
        oidc,
        username: req.username,
        sessionHash: req.sessionHash,
        setSessionCookie: (token) => {
          if (!config.auth.login) return;
          // Replaces the clearing of a stale cookie that the request may already have queued.
          res.removeHeader('set-cookie');
          res.header('set-cookie', sessionCookie(config.auth, token));
        },
      }),
      onError: ({ error, path }) => {
        if (error.code === 'INTERNAL_SERVER_ERROR') app.log.error({ err: error, path }, 'tRPC error');
      },
    } satisfies FastifyTRPCPluginOptions<AppRouter>['trpcOptions'],
  });

  return app;
}
