import type { FastifyInstance } from 'fastify';
import type { Config } from './config';
import type { Db } from './db/client';
import { cookieValue, sessionOwner, tokenShaped } from './services/auth/sessions';
import type { Changes } from './services/changes';
import { AppError } from './services/errors';

export const UI_EVENTS_PATH = '/api/ui/events';

/**
 * Server-sent events for a signed-in UI: a bare `changed` event means "read the board again". It carries no data, so
 * nothing clear leaves the server and one user's activity cannot show on another's stream: a stream listens to its own owner only.
 */
export function registerUiEvents(
  app: FastifyInstance,
  root: Db,
  config: Config,
  changes: Changes,
  pingMs: number,
): void {
  const streams = new Set<() => void>();
  // The server waits for open connections to end before it closes; these never would.
  app.addHook('preClose', async () => {
    [...streams].forEach((end) => end());
  });

  app.get(UI_EVENTS_PATH, async (req, reply) => {
    const owner = req.username;
    if (owner === null) throw new AppError('UNAUTHORIZED', 'Sign in to use the board.');
    const token = config.auth.login ? tokenShaped(cookieValue(req.headers.cookie, config.auth)) : null;
    const login = config.auth.login ? config.auth : null;

    reply.hijack();
    if (req.raw.destroyed) return;
    const res = reply.raw;
    let ended = false;
    let checking = false;

    function write(chunk: string): void {
      if (ended) return;
      try {
        res.write(chunk);
      } catch (err) {
        app.log.warn({ err }, 'ui event stream write failed');
        end();
      }
    }

    function end(): void {
      if (ended) return;
      ended = true;
      clearInterval(ping);
      stop();
      stopEnd();
      streams.delete(end);
      res.end();
    }

    const stop = changes.subscribeViews(owner, () => write('event: changed\ndata:\n\n'));
    // The user deleted their account: the session check would end the stream at the next ping, this ends it now.
    const stopEnd = changes.onEnd(owner, end);
    const ping = setInterval(() => {
      write(': ping\n\n');
      if (login === null || checking) return;
      checking = true;
      // A logged-out, expired or revoked session must not keep a stream.
      (token === null ? Promise.resolve(null) : sessionOwner(root, login, token))
        .then(
          (current) => {
            if (current !== owner) end();
          },
          (err: unknown) => app.log.error({ err }, 'ui event stream session check failed'),
        )
        .finally(() => {
          checking = false;
        });
    }, pingMs);
    streams.add(end);

    // A write to a socket that went away reports here, not to the caller of `write`.
    res.on('error', end);
    req.raw.on('close', end);

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
    });
    write(': connected\n\n');
  });
}
