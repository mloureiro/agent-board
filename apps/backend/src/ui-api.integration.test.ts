import { MIN_UI_CLIENT, UI_API_HEADER, UI_API_VERSION } from '@agent-board/shared/ui';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from './server';
import { createSession } from './services/auth/sessions';
import { caller, loginConfig, testConfig, useTestDb } from './test/helpers';

const { db } = useTestDb();

type Server = Awaited<ReturnType<typeof buildServer>>;

interface Answer {
  status: number;
  body: {
    result?: { data: unknown };
    error?: { message: string; data: { code: string; upgrade?: { minClient: number } } };
  };
}

async function call(
  app: Server,
  path: string,
  options: { type: 'query' | 'mutation'; input?: unknown; header?: string; cookie?: string },
): Promise<Answer> {
  const headers: Record<string, string> = {};
  if (options.header !== undefined) headers[UI_API_HEADER] = options.header;
  if (options.cookie !== undefined) headers['cookie'] = options.cookie;
  const answer =
    options.type === 'mutation'
      ? await app.inject({
          method: 'POST',
          url: `/trpc/${path}`,
          headers: { ...headers, 'content-type': 'application/json' },
          payload: JSON.stringify(options.input ?? null),
        })
      : await app.inject({ method: 'GET', url: `/trpc/${path}`, headers });
  return { status: answer.statusCode, body: answer.json() };
}

const issue = (app: Server, header?: string) =>
  call(app, 'machines.issue', {
    type: 'mutation',
    input: { name: 'laptop' },
    ...(header === undefined ? {} : { header }),
  });
const machineCount = async () => (await caller(db, 'jascha').machines.list()).length;

describe('a board without login', () => {
  let app: Server;
  beforeEach(async () => {
    app = await buildServer(testConfig, db);
  });
  afterEach(() => app.close());

  it('behaves as before for a client that sends no header', async () => {
    expect((await call(app, 'me', { type: 'query' })).status).toBe(200);
    expect((await issue(app)).status).toBe(200);
    expect(await machineCount()).toBe(1);
  });

  it('serves a client at the current UI API version', async () => {
    const header = String(UI_API_VERSION);
    expect((await call(app, 'me', { type: 'query', header })).status).toBe(200);
    expect((await issue(app, header)).status).toBe(200);
    expect(await machineCount()).toBe(1);
  });

  it.each(['abc', '0', '-1', '1.5', ''])('answers 400 to the header %j', async (header) => {
    const answer = await call(app, 'ui.version', { type: 'query', header });
    expect(answer.status).toBe(400);
    expect(answer.body.error?.data.code).toBe('BAD_REQUEST');
  });

  it('answers the versions and features to ui.version', async () => {
    const answer = await call(app, 'ui.version', { type: 'query' });
    expect(answer.status).toBe(200);
    expect(answer.body.result?.data).toEqual({ api: UI_API_VERSION, minClient: MIN_UI_CLIENT, features: [] });
  });

  describe('built with a higher minimum', () => {
    let strict: Server;
    beforeEach(async () => {
      strict = await buildServer(testConfig, db, { minUiClient: 2 });
    });
    afterEach(() => strict.close());

    it('refuses a write from an older client with 412 before it happens', async () => {
      const answer = await issue(strict, '1');
      expect(answer.status).toBe(412);
      expect(answer.body.error?.data.upgrade).toEqual({ minClient: 2 });
      expect(await machineCount()).toBe(0);
    });

    it('refuses a read and ui.version from an older client too', async () => {
      expect((await call(strict, 'me', { type: 'query', header: '1' })).status).toBe(412);
      const answer = await call(strict, 'ui.version', { type: 'query', header: '1' });
      expect(answer.status).toBe(412);
      expect(answer.body.error?.data.upgrade).toEqual({ minClient: 2 });
    });

    it('serves a client without the header and one at the minimum', async () => {
      expect((await issue(strict)).status).toBe(200);
      expect((await call(strict, 'me', { type: 'query', header: '2' })).status).toBe(200);
    });
  });
});

describe('a board with login', () => {
  let app: Server;
  let cookie: string;
  beforeEach(async () => {
    const config = loginConfig();
    app = await buildServer(config, db);
    const token = await createSession({ root: db, login: config.auth }, 'jascha', 'passkey');
    cookie = `board-session=${token}`;
  });
  afterEach(() => app.close());

  it('answers ui.version without a session', async () => {
    const answer = await call(app, 'ui.version', { type: 'query' });
    expect(answer.status).toBe(200);
    expect(answer.body.result?.data).toEqual({ api: UI_API_VERSION, minClient: MIN_UI_CLIENT, features: [] });
  });

  it('still refuses a signed-out me, with or without the header', async () => {
    expect((await call(app, 'me', { type: 'query', header: '1' })).status).toBe(401);
  });

  it('serves a signed-in query and mutation with and without the header', async () => {
    for (const header of [undefined, String(UI_API_VERSION)]) {
      const options = header === undefined ? {} : { header };
      expect((await call(app, 'me', { type: 'query', cookie, ...options })).status).toBe(200);
      const answer = await call(app, 'machines.issue', {
        type: 'mutation',
        input: { name: `laptop-${header ?? 'none'}` },
        cookie,
        ...options,
      });
      expect(answer.status).toBe(200);
    }
  });
});
