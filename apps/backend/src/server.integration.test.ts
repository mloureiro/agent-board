import {
  API_VERSION,
  inputBinding,
  LEGACY_CONTRACT,
  MIN_CLIENT,
  SERVER_FEATURES,
  sealFields,
  sealNote,
  TAKE_BACK_AFTER_MS,
} from '@agent-board/shared';
import { eq, sql } from 'drizzle-orm';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { schedules, tasks } from './db/schema';
import { appRouter } from './trpc/router';
import { buildServer } from './server';
import { recordClient } from './services/machines';
import { archiveStaleDone } from './services/tasks';
import { plainMachine, plainUi, type MachineAnswer } from './test/client';
import { sealed } from './test/sealed';
import { createSession } from './services/auth/sessions';
import {
  asOwner,
  caller,
  question,
  SEALED,
  SESSION,
  sessionNamed,
  testConfig,
  testContext,
  useTestDb,
  loginConfig,
} from './test/helpers';

const { db, admin } = useTestDb();

async function setup() {
  const app = await buildServer(testConfig, db);
  const issue = async (name: string) => (await caller(db).machines.issue({ name })).token;
  const tokens = { laptop: await issue('laptop'), workstation: await issue('workstation') };
  const raw = async (machine: keyof typeof tokens, command: string, body: Record<string, unknown> = {}) => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/machine/${command}`,
      headers: { authorization: `Bearer ${tokens[machine]}` },
      payload: body,
    });
    return { status: res.statusCode, json: res.json() as MachineAnswer['json'] };
  };
  const plain = {
    laptop: plainMachine((command, body) => raw('laptop', command, body)),
    workstation: plainMachine((command, body) => raw('workstation', command, body)),
  };
  /** Plaintext in and out, like the CLI; `raw` sends the body as it is. */
  const call = (machine: keyof typeof tokens, command: string, body: Record<string, unknown> = {}) =>
    plain[machine](command, body);
  return { app, call, raw };
}

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  ctx = await setup();
});

const pr = 'https://github.com/cosuno/cosuno/pull/1';

describe('machine API', () => {
  it('refuses a missing, unknown or revoked token', async () => {
    const none = await ctx.app.inject({ method: 'POST', url: '/api/machine/list-tasks', payload: {} });
    expect(none.statusCode).toBe(401);
    const wrong = await ctx.app.inject({
      method: 'POST',
      url: '/api/machine/list-tasks',
      headers: { authorization: 'Bearer abm_nope' },
      payload: {},
    });
    expect(wrong.statusCode).toBe(401);
    await caller(db).machines.revoke({ name: 'laptop' });
    expect((await ctx.call('laptop', 'list-tasks')).status).toBe(401);
    expect((await ctx.call('workstation', 'list-tasks')).status).toBe(200);
  });

  describe('body size', () => {
    const MiB = 1024 * 1024;
    const bearer = async () => ({
      authorization: `Bearer ${(await caller(db).machines.issue({ name: 'big' })).token}`,
    });
    const json = { 'content-type': 'application/json' };
    const filler = (bytes: number) => JSON.stringify({ pad: 'x'.repeat(bytes) });

    it('refuses a body over the limit of a normal command, also one without a Content-Length', async () => {
      const headers = { ...json, ...(await bearer()) };
      const sized = await ctx.app.inject({
        method: 'POST',
        url: '/api/machine/list-tasks',
        headers,
        payload: filler(3 * MiB),
      });
      expect(sized.statusCode).toBe(413);
      const chunks = Array.from({ length: 6 }, () => Buffer.from('x'.repeat(MiB)));
      const chunked = await ctx.app.inject({
        method: 'POST',
        url: '/api/machine/list-tasks',
        headers: { ...headers, 'transfer-encoding': 'chunked' },
        payload: Readable.from(chunks),
      });
      expect(chunked.statusCode).toBe(413);
    });

    it('takes a body just under the limit of a normal command', async () => {
      const headers = { ...json, ...(await bearer()) };
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/machine/list-tasks',
        headers,
        payload: filler(2 * MiB - 1024),
      });
      expect(res.statusCode).toBe(200);
    });

    it('answers a bad token with 401 before reading the body: not 413, and not 400 for a body that is not JSON', async () => {
      const huge = await ctx.app.inject({
        method: 'POST',
        url: '/api/machine/list-tasks',
        headers: { ...json, authorization: 'Bearer abm_nope' },
        payload: filler(20 * MiB),
      });
      expect(huge.statusCode).toBe(401);
      expect(huge.json()).toEqual({ error: 'unknown or revoked machine token' });
      for (const headers of [json, { ...json, authorization: 'Bearer abm_nope' }]) {
        for (const [method, url] of [
          ['POST', '/api/machine/transcript'],
          ['POST', '/api/machine/list-tasks/'],
          ['POST', '/api/machine/a/b'],
          ['POST', '/api/machine/'],
          ['PUT', '/api/machine/list-tasks'],
          ['PATCH', '/api/machine/list-tasks'],
          ['DELETE', '/api/machine/list-tasks'],
        ] as const) {
          const broken = await ctx.app.inject({ method, url, headers, payload: '{not json' });
          expect([method, url, broken.statusCode]).toEqual([method, url, 401]);
        }
      }
      const unmatchedHuge = await ctx.app.inject({
        method: 'POST',
        url: '/api/machine/a/b',
        headers: json,
        payload: filler(15 * MiB),
      });
      expect(unmatchedHuge.statusCode).toBe(401);
      // With a good token the same body reaches the parser.
      const parsed = await ctx.app.inject({
        method: 'POST',
        url: '/api/machine/list-tasks',
        headers: { ...json, ...(await bearer()) },
        payload: '{not json',
      });
      expect(parsed.statusCode).toBe(400);
    });

    it('answers an unknown path or method with 404 JSON once the token is good', async () => {
      const headers = await bearer();
      for (const [method, url] of [
        ['POST', '/api/machine/a/b'],
        ['POST', '/api/machine/list-tasks/'],
        ['PUT', '/api/machine/list-tasks'],
      ] as const) {
        const res = await ctx.app.inject({ method, url, headers });
        expect([method, url, res.statusCode]).toEqual([method, url, 404]);
        expect(res.json()).toHaveProperty('error');
      }
    });

    it('keeps the 401 on the event stream', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: '/api/machine/events' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'unknown or revoked machine token' });
    });

    it('lets `transcript` alone take a large body, up to 16 MiB', async () => {
      const task = await plainUi(db).tasks.create({ input: '/grill' });
      const output = `abe1.${'A'.repeat(1_350_000)}`;
      const at = new Date(Date.UTC(2026, 10, 13, 12, 0, 1)).toISOString();
      const events = Array.from({ length: 11 }, (_, seq) => ({
        seq,
        at,
        parent: null,
        kind: 'tool_result',
        data: SEALED,
        output,
        outputSize: 1000,
      }));
      const batch = { runId: 'run-big-0001', startedAt: at, sessionId: null, resumed: false, events };
      const payload = JSON.stringify({ id: task.id, body: batch });
      expect(payload.length).toBeGreaterThan(14 * MiB);
      expect(payload.length).toBeLessThan(16 * MiB);
      const headers = { ...json, ...(await bearer()) };
      const res = await ctx.app.inject({ method: 'POST', url: '/api/machine/transcript', headers, payload });
      expect(res.statusCode).toBe(200);
      const over = await ctx.app.inject({
        method: 'POST',
        url: '/api/machine/transcript',
        headers,
        payload: filler(17 * MiB),
      });
      expect(over.statusCode).toBe(413);
    });
  });

  it('answers the break level range and features it has, and the legacy contract number for older CLIs', async () => {
    const { status, json } = await ctx.call('laptop', 'version');
    expect(status).toBe(200);
    expect(json.result).toEqual({
      contract: LEGACY_CONTRACT,
      owner: 'jascha',
      keyId: null,
      api: { version: API_VERSION, minClient: MIN_CLIENT },
      features: [...SERVER_FEATURES],
      dirsIndex: null,
      catalogIndex: null,
      usageIndex: null,
      sourcesIndex: null,
      sourceRequests: [],
      agentsVersion: null,
    });
    expect(LEGACY_CONTRACT).toBe(9);
    expect(json.result.features).toContain('task.configure');
  });

  it('does not open the machine API for a UI user', async () => {
    const spoof = await ctx.app.inject({
      method: 'POST',
      url: '/api/machine/list-tasks',
      headers: {
        authorization: `Bearer ${await createSession({ root: db, login: loginConfig().auth }, 'jascha', 'passkey')}`,
      },
      payload: {},
    });
    expect(spoof.statusCode).toBe(401);
  });

  it('round-trips the contract: add, list, update, note, read', async () => {
    const added = await ctx.call('laptop', 'add-task', {
      body: { title: '#1 PR', input: pr, head: 'abc1234', labels: ['review-pr'], dedupeKey: pr, createdBy: 'intake' },
    });
    expect(added.status).toBe(200);
    const task = added.json.result.task;
    expect(added.json.result.created).toBe(true);
    expect(task).toMatchObject({
      status: 'todo',
      input: pr,
      head: await sealed.headIndex('abc1234'),
      machine: null,
      sessionId: null,
      next: 'fresh',
      openQuestion: false,
      runStartedAt: null,
      paused: false,
    });
    // The board sends no link of its own: the CLI builds every link from its web.json and the id.
    expect(task).not.toHaveProperty('url');
    expect(task.id).toMatch(/^[A-Za-z0-9]{12}$/);

    const list = await ctx.call('laptop', 'list-tasks');
    expect(list.json.result.map((t: { id: string }) => t.id)).toEqual([task.id]);

    const updated = await ctx.call('laptop', 'update-task', {
      id: task.id,
      body: { sessionId: SESSION, next: 'fresh' },
    });
    expect(updated.json.result.sessionId).toBe(SESSION);

    await ctx.call('laptop', 'add-note', { id: task.id, body: 'Review started' });
    await ctx.call('laptop', 'add-note', { id: task.id, author: 'system', body: 'agent-board: started x' });
    const notes = await ctx.call('laptop', 'read-notes', { id: task.id });
    expect(
      notes.json.result.map((n: { text: string; author: string; kind: string }) => [n.text, n.author, n.kind]),
    ).toEqual([
      ['Review started', 'agent', 'comment'],
      ['agent-board: started x', 'system', 'event'],
    ]);
  });

  it('counts the notes of a task in list-tasks, get-task and the answer of a write', async () => {
    const quiet = (await ctx.call('laptop', 'add-task', { body: { title: 'quiet', input: 'a' } })).json.result.task;
    const busy = (await ctx.call('laptop', 'add-task', { body: { title: 'busy', input: 'b' } })).json.result.task;
    expect(quiet.noteCount).toBe(0);
    await ctx.call('laptop', 'add-note', { id: busy.id, body: 'one' });
    await ctx.call('laptop', 'add-note', { id: busy.id, author: 'system', body: 'two' });
    const counts = async () =>
      Object.fromEntries(
        (await ctx.call('laptop', 'list-tasks')).json.result.map((t: { id: string; noteCount: number }) => [
          t.id,
          t.noteCount,
        ]),
      );
    expect(await counts()).toEqual({ [quiet.id]: 0, [busy.id]: 2 });
    expect((await ctx.call('laptop', 'get-task', { id: busy.id })).json.result.noteCount).toBe(2);
    const moved = await ctx.call('laptop', 'update-task', { id: busy.id, body: { priority: 'high' } });
    const thread = (await ctx.call('laptop', 'read-notes', { id: busy.id })).json.result;
    expect(moved.json.result.noteCount).toBe(thread.length);
  });

  it('refuses bad input with the parser reason', async () => {
    const bad = await ctx.call('laptop', 'update-task', { id: 'abcdefgh', body: { title: 'x' } });
    expect(bad).toMatchObject({ status: 400, json: { error: 'patch has an unknown key "title"' } });
    const missing = await ctx.call('laptop', 'get-task', { id: 'abcdefgh' });
    expect(missing.status).toBe(404);
    const badId = await ctx.call('laptop', 'get-task', { id: '../x' });
    expect(badId.status).toBe(400);
  });

  it('dedupes intake across machines', async () => {
    const body = { title: '#1', input: pr, labels: ['review-pr'], dedupeKey: pr };
    const [a, b] = await Promise.all([
      ctx.call('laptop', 'add-task', { body }),
      ctx.call('workstation', 'add-task', { body }),
    ]);
    const results = [a.json.result, b.json.result];
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results[0].task.id).toBe(results[1].task.id);
  });

  it('lets exactly one machine win a claim, and only for its own name', async () => {
    const { json } = await ctx.call('laptop', 'add-task', { body: { title: 't', labels: ['review-pr'] } });
    const id = json.result.task.id;
    const forged = await ctx.call('laptop', 'claim-task', { id, machine: 'workstation' });
    expect(forged.status).toBe(403);
    const claims = await Promise.all([
      ctx.call('laptop', 'claim-task', { id, machine: 'laptop' }),
      ctx.call('workstation', 'claim-task', { id, machine: 'workstation' }),
    ]);
    expect(claims.map((c) => c.status).sort()).toEqual([200, 409]);
    const winner = claims.find((c) => c.status === 200)!.json.result;
    expect(winner.status).toBe('running');
  });

  it('hands a session to the machine that ran the task, and to no other', async () => {
    const { json } = await ctx.call('laptop', 'add-task', { body: { title: 't', labels: ['review-pr'] } });
    const id = json.result.task.id;
    expect((await ctx.call('laptop', 'attach-session', { id })).status).toBe(409);
    await ctx.call('laptop', 'claim-task', { id, machine: 'laptop' });
    const running = await ctx.call('laptop', 'attach-session', { id });
    expect(running).toMatchObject({ status: 409, json: { error: expect.stringMatching(/running.*Transcript/) } });
    await ctx.call('laptop', 'update-task', { id, body: { workdir: '/home/me/repo' } });
    await ctx.call('laptop', 'update-task', { id, body: { status: 'needs-me' } });
    const noSession = await ctx.call('laptop', 'attach-session', { id });
    expect(noSession).toMatchObject({ status: 409, json: { error: 'the task has no session' } });
    await ctx.call('laptop', 'claim-task', { id, machine: 'laptop' });
    await ctx.call('laptop', 'update-task', { id, body: { sessionId: SESSION } });
    await ctx.call('laptop', 'update-task', { id, body: { status: 'needs-me' } });
    const handed = await ctx.call('laptop', 'attach-session', { id });
    expect(handed.status).toBe(200);
    expect(handed.json.result).toMatchObject({ id, sessionId: SESSION, workdir: '/home/me/repo' });
    const other = await ctx.call('workstation', 'attach-session', { id });
    expect(other).toMatchObject({
      status: 403,
      json: { error: 'the session lives on laptop, not on workstation' },
    });
    expect((await ctx.call('laptop', 'attach-session', { id: 'abcdefgh' })).status).toBe(404);
  });

  it('ask → answer → resume is pinned to the machine that holds the session', async () => {
    const { json } = await ctx.call('laptop', 'add-task', { body: { title: 't', labels: ['review-pr'] } });
    const id = json.result.task.id;
    await ctx.call('laptop', 'claim-task', { id, machine: 'laptop' });
    await ctx.call('laptop', 'update-task', { id, body: { sessionId: SESSION } });
    expect((await ctx.call('laptop', 'ask', { id, body: { questions: [question] } })).status).toBe(200);

    const asked = (await ctx.call('laptop', 'get-task', { id })).json.result;
    expect(asked).toMatchObject({ status: 'needs-me', openQuestion: true });

    const ui = plainUi(db);
    const { thread } = await ui.tasks.get({ id });
    const questionNote = thread.find((n) => n.kind === 'question')!;
    await expect(
      ui.tasks.answer({ id, questionNoteId: 'not-the-open-one', answers: [{ selected: ['Yes'] }] }),
    ).rejects.toThrow(/already answered/);
    const answered = await ui.tasks.answer({
      id,
      questionNoteId: questionNote.id,
      answers: [{ selected: ['Yes'], other: 'and the seed' }],
      message: 'thanks',
    });
    expect(answered).toMatchObject({ status: 'todo', next: 'resume', openQuestion: false, machine: 'laptop' });
    await expect(
      ui.tasks.answer({ id, questionNoteId: questionNote.id, answers: [{ selected: ['Yes'] }] }),
    ).rejects.toThrow(/already answered/);

    expect((await ctx.call('workstation', 'claim-task', { id, machine: 'workstation' })).status).toBe(409);
    expect((await ctx.call('laptop', 'claim-task', { id, machine: 'laptop' })).status).toBe(200);

    const notes = (await ctx.call('laptop', 'read-notes', { id })).json.result;
    const answer = notes.find((n: { kind: string }) => n.kind === 'answer');
    expect(answer).toMatchObject({
      author: 'user',
      text: 'thanks',
      questionNoteId: questionNote.id,
      answers: [{ selected: ['Yes'], other: 'and the seed' }],
    });
  });
});

describe('dismissing the open question', () => {
  async function asked() {
    const { json } = await ctx.call('laptop', 'add-task', { body: { title: 't', labels: ['review-pr'] } });
    const id = json.result.task.id;
    await ctx.call('laptop', 'claim-task', { id, machine: 'laptop' });
    await ctx.call('laptop', 'update-task', { id, body: { sessionId: SESSION } });
    expect((await ctx.call('laptop', 'ask', { id, body: { questions: [question] } })).status).toBe(200);
    const ui = plainUi(db);
    const { thread } = await ui.tasks.get({ id });
    return { id, ui, questionId: thread.find((n) => n.kind === 'question')!.id };
  }

  it('drops the question, keeps the task in Needs me and writes no note', async () => {
    const { id, ui, questionId } = await asked();
    const before = (await ui.tasks.get({ id })).thread.length;
    const dismissed = await ui.tasks.dismissQuestion({ id, questionNoteId: questionId });
    expect(dismissed).toMatchObject({ status: 'needs-me', openQuestion: false, machine: 'laptop' });
    const { thread } = await ui.tasks.get({ id });
    expect(thread).toHaveLength(before);
    expect(thread.filter((n) => n.kind === 'answer')).toEqual([]);
    expect((await ctx.call('laptop', 'get-task', { id })).json.result).toMatchObject({
      status: 'needs-me',
      openQuestion: false,
    });
  });

  it('refuses a note that is not the open question, and a second dismissal', async () => {
    const { id, ui, questionId } = await asked();
    await expect(ui.tasks.dismissQuestion({ id, questionNoteId: 'not-the-open-one' })).rejects.toThrow(
      /already answered or replaced/,
    );
    expect((await ui.tasks.get({ id })).task).toMatchObject({ openQuestion: true });
    await ui.tasks.dismissQuestion({ id, questionNoteId: questionId });
    await expect(ui.tasks.dismissQuestion({ id, questionNoteId: questionId })).rejects.toThrow(
      /already answered or replaced/,
    );
    await expect(ui.tasks.answer({ id, questionNoteId: questionId, answers: [{ selected: ['Yes'] }] })).rejects.toThrow(
      /already answered/,
    );
  });

  it('lets a reply resume the task as usual', async () => {
    const { id, ui, questionId } = await asked();
    await ui.tasks.dismissQuestion({ id, questionNoteId: questionId });
    const replied = await ui.tasks.reply({ id, message: 'start over', resume: true });
    expect(replied).toMatchObject({ status: 'todo', next: 'resume', openQuestion: false, machine: 'laptop' });
  });
});

describe('board UI', () => {
  it('a reply with resume goes to the top of Todo; without a session it runs fresh', async () => {
    const ui = plainUi(db);
    const first = await ui.tasks.create({ title: 'first', input: 'do it' });
    const second = await ui.tasks.create({ title: 'second', input: 'Find out X', when: 'hold' });
    expect(second.status).toBe('needs-me');
    const replied = await ui.tasks.reply({ id: second.id, message: 'go', resume: true });
    expect(replied).toMatchObject({ status: 'todo', next: 'fresh' });
    const todo = (await ui.tasks.list()).filter((t) => t.status === 'todo').map((t) => t.title);
    expect(todo).toEqual(['second', 'first']);
    expect(first.status).toBe('todo');
  });

  it('creates a task in Todo, Backlog or Needs me by `when`', async () => {
    const ui = plainUi(db);
    expect((await ui.tasks.create({ input: 'a' })).status).toBe('todo');
    expect((await ui.tasks.create({ input: 'b', when: 'now' })).status).toBe('todo');
    expect((await ui.tasks.create({ input: 'c', when: 'backlog' })).status).toBe('backlog');
    expect((await ui.tasks.create({ input: 'd', when: 'hold' })).status).toBe('needs-me');
  });

  it('a Backlog task cannot be claimed; moving it to Todo makes it claimable and back parks it', async () => {
    const ui = plainUi(db);
    const { id } = await ui.tasks.create({ input: 'later', when: 'backlog' });
    expect((await ctx.call('laptop', 'claim-task', { id, machine: 'laptop' })).status).toBe(409);
    expect(await ui.tasks.move({ id, status: 'todo' })).toMatchObject({ status: 'todo' });
    expect(await ui.tasks.move({ id, status: 'backlog' })).toMatchObject({ status: 'backlog' });
    expect((await ctx.call('laptop', 'claim-task', { id, machine: 'laptop' })).status).toBe(409);
    await ui.tasks.move({ id, status: 'todo' });
    expect((await ctx.call('laptop', 'claim-task', { id, machine: 'laptop' })).status).toBe(200);
  });

  it('lists Backlog before Todo', async () => {
    const ui = plainUi(db);
    await ui.tasks.create({ title: 'todo', input: 'a' });
    await ui.tasks.create({ title: 'parked', input: 'b', when: 'backlog' });
    expect((await ui.tasks.list()).map((t) => t.title)).toEqual(['parked', 'todo']);
  });

  it('a running task cannot be answered, moved or closed from the UI', async () => {
    const ui = plainUi(db);
    const task = await ui.tasks.create({ title: 't', input: 'do it' });
    await ctx.call('laptop', 'claim-task', { id: task.id, machine: 'laptop' });
    await expect(ui.tasks.reply({ id: task.id, message: 'x', resume: true })).rejects.toThrow(/running/);
    await expect(ui.tasks.move({ id: task.id, status: 'done' })).rejects.toThrow(/running/);
    await expect(ui.tasks.setClosed({ id: task.id, closed: true })).rejects.toThrow(/running/);
    // A comment without resume is fine while it runs.
    await ui.tasks.reply({ id: task.id, message: 'fyi', resume: false });
  });

  it('agent proposals wait in backlog until started; moving into Todo starts them', async () => {
    const ui = plainUi(db);
    const parent = await ui.tasks.create({ title: 'parent', input: 'do it' });
    const proposed = await ctx.call('laptop', 'add-task', {
      body: {
        title: 'follow-up',
        input: 'do Y',
        labels: ['research'],
        status: 'needs-me',
        createdBy: 'agent',
        parentId: parent.id,
      },
    });
    const id = proposed.json.result.task.id;
    const before = await ui.tasks.get({ id });
    expect(before.task).toMatchObject({ proposed: true, status: 'backlog', parentId: parent.id });
    expect((await ui.tasks.get({ id: parent.id })).followUps.map((t) => t.id)).toEqual([id]);
    const started = await ui.tasks.move({ id, status: 'todo' });
    expect(started).toMatchObject({ proposed: false, status: 'todo', createdBy: 'user', input: 'do Y' });
  });

  it('a proposal in backlog goes below the user’s backlog tasks, and stays startable and closable there', async () => {
    const ui = plainUi(db);
    const mine = await ui.tasks.create({ title: 'mine', input: 'do it', when: 'backlog' });
    const { id } = (
      await ctx.call('laptop', 'add-task', { body: { title: 'idea', input: 'do Y', createdBy: 'agent' } })
    ).json.result.task;
    expect((await ui.tasks.list()).filter((t) => t.status === 'backlog').map((t) => t.id)).toEqual([mine.id, id]);
    await expect(ui.tasks.setClosed({ id, closed: true })).resolves.toMatchObject({ closed: true });
  });

  it('drag and drop places a task between its neighbours', async () => {
    const ui = plainUi(db);
    const a = await ui.tasks.create({ title: 'a', input: 'do it' });
    const b = await ui.tasks.create({ title: 'b', input: 'do it' });
    const c = await ui.tasks.create({ title: 'c', input: 'do it' });
    await ui.tasks.move({ id: c.id, status: 'todo', afterId: a.id, beforeId: b.id });
    expect((await ui.tasks.list()).map((t) => t.title)).toEqual(['a', 'c', 'b']);
    await ui.tasks.move({ id: a.id, status: 'done' });
    await expect(ui.tasks.move({ id: b.id, status: 'running' })).rejects.toThrow(/Only a worker/);
  });

  it('done and re-run clear the open question; re-run forgets the session', async () => {
    const ui = plainUi(db);
    const task = await ui.tasks.create({ title: 't', input: 'do it' });
    await ctx.call('laptop', 'claim-task', { id: task.id, machine: 'laptop' });
    await ctx.call('laptop', 'update-task', { id: task.id, body: { sessionId: SESSION } });
    await ctx.call('laptop', 'ask', { id: task.id, body: [question] });
    const rerun = await ui.tasks.rerun({ id: task.id });
    expect(rerun).toMatchObject({ status: 'todo', next: 'fresh', sessionId: null, openQuestion: false });
  });

  it('a machine token is shown once and works at once', async () => {
    const ui = plainUi(db);
    const { token } = await ui.machines.issue({ name: 'new-box' });
    expect(token).toMatch(/^abm_/);
    await expect(ui.machines.issue({ name: 'bad name' })).rejects.toThrow(/machine name/);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/machine/list-tasks',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const listed = await ui.machines.list();
    expect(listed.find((m) => m.name === 'new-box')?.lastSeenAt).not.toBeNull();
    expect(JSON.stringify(listed)).not.toContain('token');
  });
});

describe('what machines report about their CLI', () => {
  const CURRENT = String(API_VERSION);
  async function advertising(cliVersion: string | null) {
    const config = { ...testConfig, cliVersion };
    const app = await buildServer(config, db);
    const ui = appRouter.createCaller(testContext(db, 'jascha', { config }));
    const { token } = await ui.machines.issue({ name: 'laptop' });
    const call = (command: string, headers: Record<string, string> = {}) =>
      app.inject({
        method: 'POST',
        url: `/api/machine/${command}`,
        headers: { authorization: `Bearer ${token}`, ...headers },
        payload: {},
      });
    return { ui, call };
  }
  const reported = async (ui: Awaited<ReturnType<typeof advertising>>['ui']) => {
    const [machine] = await ui.machines.list();
    return { version: machine?.clientVersion, status: machine?.clientStatus };
  };

  it('advertises the newest CLI in the version answer only when it knows one', async () => {
    const known = await advertising('0.7.0');
    expect((await known.call('version')).json().result).toMatchObject({ cli: '0.7.0' });
    expect(await known.ui.machines.advertisedCli()).toBe('0.7.0');
    const unknown = await advertising(null);
    expect((await unknown.call('version')).json().result).not.toHaveProperty('cli');
    expect(await unknown.ui.machines.advertisedCli()).toBeNull();
  });

  it('is unknown before a machine sends its headers', async () => {
    const { ui, call } = await advertising('0.7.0');
    await call('list-tasks');
    expect(await reported(ui)).toEqual({ version: null, status: 'unknown' });
  });

  it('takes the headers of `version` only, so a long-running worker’s heartbeats do not undo an update', async () => {
    const { ui, call } = await advertising('0.7.0');
    await call('version', { 'x-board-client': '0.7.0', 'x-board-client-api': CURRENT });
    await call('list-tasks', { 'x-board-client': '0.1.0', 'x-board-client-api': '1' });
    expect(await reported(ui)).toEqual({ version: '0.7.0', status: 'current' });
  });

  it('stores the version and API level, and judges outdated, current, development and incompatible', async () => {
    const { ui, call } = await advertising('0.7.0');
    const send = (version: string, api = CURRENT) =>
      call('version', { 'x-board-client': version, 'x-board-client-api': api });
    await send('0.6.0');
    expect(await reported(ui)).toEqual({ version: '0.6.0', status: 'outdated' });
    await send('0.7.0');
    expect(await reported(ui)).toEqual({ version: '0.7.0', status: 'current' });
    await send('0.7.0-dev');
    expect(await reported(ui)).toEqual({ version: '0.7.0-dev', status: 'current' });
    await send('0.6.0-dev');
    expect((await reported(ui)).status).toBe('outdated');
    await send('0.6.0', String(MIN_CLIENT - 1));
    expect((await reported(ui)).status).toBe('incompatible');
    await send('0.6.0', String(MIN_CLIENT));
    expect((await reported(ui)).status).toBe('outdated');
    await send('0.6.0', String(API_VERSION + 5));
    expect((await reported(ui)).status).toBe('outdated');
  });

  it('is never outdated when the server knows no newest CLI', async () => {
    const { ui, call } = await advertising(null);
    await call('version', { 'x-board-client': '0.1.0', 'x-board-client-api': CURRENT });
    expect((await reported(ui)).status).toBe('current');
  });

  it('ignores malformed headers instead of refusing the request', async () => {
    const { ui, call } = await advertising('0.7.0');
    await call('version', { 'x-board-client': '0.6.0', 'x-board-client-api': CURRENT });
    for (const headers of [
      { 'x-board-client': 'hello', 'x-board-client-api': '0' },
      { 'x-board-client': '1.2.3-' + 'x'.repeat(30), 'x-board-client-api': '10001' },
      { 'x-board-client': '1.2', 'x-board-client-api': '1.5' },
    ]) {
      expect((await call('version', headers)).statusCode).toBe(200);
    }
    expect(await reported(ui)).toEqual({ version: '0.6.0', status: 'outdated' });
  });

  it('writes only when what a machine reports changes', async () => {
    const { ui } = await advertising('0.7.0');
    const record = (version: string) =>
      asOwner(db, 'jascha', (tx) => recordClient(tx, 'laptop', { version, api: API_VERSION }));
    const xmin = async () =>
      (await admin.execute<{ xmin: string }>(sql`select xmin::text from machine where name = 'laptop'`)).rows[0]?.xmin;
    await record('0.6.0');
    const before = await xmin();
    await record('0.6.0');
    await record('0.6.0');
    expect(await xmin()).toBe(before);
    await record('0.7.0');
    expect(await xmin()).not.toBe(before);
    expect(await reported(ui)).toEqual({ version: '0.7.0', status: 'current' });
  });

  it('a new token forgets what the old one reported', async () => {
    const { ui, call } = await advertising('0.7.0');
    await call('version', { 'x-board-client': '0.6.0', 'x-board-client-api': CURRENT });
    await ui.machines.issue({ name: 'laptop' });
    expect(await reported(ui)).toEqual({ version: null, status: 'unknown' });
  });
});

describe('machine names', () => {
  it('takes 64 characters of the tight character set, and states the limit when a name is too long', async () => {
    const ui = plainUi(db);
    expect((await ui.machines.issue({ name: 'm'.repeat(64) })).token).toMatch(/^abm_/);
    await expect(ui.machines.issue({ name: 'm'.repeat(65) })).rejects.toThrow(/1 to 64 characters/);
    await expect(ui.machines.issue({ name: 'old laptop' })).rejects.toThrow(/letters, digits/);
  });

  it('revokes a token whose name no longer passes the check, which an earlier release accepted', async () => {
    const ui = plainUi(db);
    const odd = 'old laptop (2019) with a name that an earlier release accepted';
    const name = odd.slice(0, 64);
    const token = 'abm_legacy-token';
    await admin.execute(
      sql`insert into machine (owner, name, token_hash) values ('jascha', ${name}, encode(sha256(${token}::bytea), 'hex'))`,
    );
    const call = () =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/machine/list-tasks',
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
    expect((await call()).statusCode).toBe(200);
    await ui.machines.revoke({ name });
    expect((await call()).statusCode).toBe(401);
    expect((await ui.machines.list()).find((m) => m.name === name)?.revokedAt).not.toBeNull();
  });
});

describe('priority', () => {
  const titles = (rows: { title: string; status: string }[], status = 'todo') =>
    rows.filter((t) => t.status === status).map((t) => t.title);

  it('columns sort by priority, then manual order; list-tasks hands workers the urgent ones first', async () => {
    const ui = plainUi(db);
    await ui.tasks.create({ title: 'normal-1', input: 'do it' });
    await ui.tasks.create({ title: 'low', input: 'do it', priority: 'low' });
    await ui.tasks.create({ title: 'urgent', input: 'do it', priority: 'urgent' });
    await ui.tasks.create({ title: 'normal-2', input: 'do it' });
    expect(titles(await ui.tasks.list())).toEqual(['urgent', 'normal-1', 'normal-2', 'low']);
    const machine = (await ctx.call('laptop', 'list-tasks')).json.result;
    expect(machine.map((t: { title: string; priority: string }) => `${t.title}:${t.priority}`)).toEqual([
      'urgent:urgent',
      'normal-1:normal',
      'normal-2:normal',
      'low:low',
    ]);
  });

  it('a new priority puts the task at the bottom of its new band and notes it', async () => {
    const ui = plainUi(db);
    await ui.tasks.create({ title: 'high-1', input: 'do it', priority: 'high' });
    const task = await ui.tasks.create({ title: 'normal', input: 'do it' });
    await ui.tasks.create({ title: 'high-2', input: 'do it', priority: 'high' });
    await ui.tasks.setPriority({ id: task.id, priority: 'high' });
    expect(titles(await ui.tasks.list())).toEqual(['high-1', 'high-2', 'normal']);
    const { thread } = await ui.tasks.get({ id: task.id });
    expect(thread.at(-1)?.text).toBe('Priority normal → high.');
  });

  it('a reply jumps to the top of its own band, not above more urgent work', async () => {
    const ui = plainUi(db);
    await ui.tasks.create({ title: 'urgent', input: 'do it', priority: 'urgent' });
    await ui.tasks.create({ title: 'normal-old', input: 'do it' });
    const waiting = await ui.tasks.create({ title: 'replied', input: 'do it', when: 'hold' });
    await ui.tasks.reply({ id: waiting.id, message: 'go', resume: true });
    expect(titles(await ui.tasks.list())).toEqual(['urgent', 'replied', 'normal-old']);
  });

  it('a dropped card takes the priority of the tasks it lands among', async () => {
    const ui = plainUi(db);
    const urgent = await ui.tasks.create({ title: 'urgent', input: 'do it', priority: 'urgent' });
    const n1 = await ui.tasks.create({ title: 'n1', input: 'do it' });
    const n2 = await ui.tasks.create({ title: 'n2', input: 'do it' });
    const low = await ui.tasks.create({ title: 'low', input: 'do it', priority: 'low' });
    // Between two normals: normal.
    const moved = await ui.tasks.move({ id: urgent.id, status: 'todo', afterId: n1.id, beforeId: n2.id });
    expect(moved.priority).toBe('normal');
    expect(titles(await ui.tasks.list())).toEqual(['n1', 'urgent', 'n2', 'low']);
    // Above everything, below nothing: the one below it.
    expect((await ui.tasks.move({ id: low.id, status: 'todo', beforeId: n1.id })).priority).toBe('normal');
    // Within its own band it keeps its priority.
    expect((await ui.tasks.move({ id: n2.id, status: 'todo', beforeId: n1.id })).priority).toBe('normal');
  });

  it('Needs me and Done list the task updated last on top, whatever its priority; a drop there keeps it', async () => {
    const ui = plainUi(db);
    const urgent = await ui.tasks.create({ title: 'urgent', input: 'do it', priority: 'urgent', when: 'hold' });
    const low = await ui.tasks.create({ title: 'low', input: 'do it', priority: 'low', when: 'hold' });
    const normal = await ui.tasks.create({ title: 'normal', input: 'do it', when: 'hold' });
    expect(titles(await ui.tasks.list(), 'needs-me')).toEqual(['normal', 'low', 'urgent']);
    await ui.tasks.reply({ id: urgent.id, message: 'still there?', resume: false });
    expect(titles(await ui.tasks.list(), 'needs-me')).toEqual(['urgent', 'normal', 'low']);
    await ui.tasks.move({ id: low.id, status: 'done' });
    const dropped = await ui.tasks.move({ id: normal.id, status: 'done', afterId: low.id });
    expect(dropped.priority).toBe('normal');
    expect(titles(await ui.tasks.list(), 'done')).toEqual(['normal', 'low']);
  });

  it('the notes of one move stay in write order, in the thread and on the card', async () => {
    const ui = plainUi(db);
    const normal = await ui.tasks.create({ title: 'normal', input: 'do it' });
    const urgent = await ui.tasks.create({ title: 'urgent', input: 'do it', priority: 'urgent', when: 'backlog' });
    const card = await ui.tasks.create({ title: 'card', input: 'do it' });
    for (let i = 0; i < 20; i++) {
      // Across columns and priorities: two notes in one transaction. Above the urgent one it turns urgent, below the normal one normal.
      const [from, to, was, now] =
        i % 2 === 0
          ? (['todo', 'backlog', 'normal', 'urgent'] as const)
          : (['backlog', 'todo', 'urgent', 'normal'] as const);
      await ui.tasks.move(
        i % 2 === 0
          ? { id: card.id, status: to, beforeId: urgent.id }
          : { id: card.id, status: to, afterId: normal.id },
      );
      const { thread } = await ui.tasks.get({ id: card.id });
      expect(thread.slice(-2).map((n) => n.text)).toEqual([
        `Moved from ${from} to ${to}.`,
        `Priority ${was} → ${now}.`,
      ]);
      const listed = (await ui.tasks.list()).find((t) => t.id === card.id);
      expect(listed?.lastNote?.text).toBe(`Priority ${was} → ${now}.`);
    }
  });

  it('follow-ups inherit the parent priority unless the agent sets one', async () => {
    const ui = plainUi(db);
    const parent = await ui.tasks.create({ title: 'parent', input: 'do it', priority: 'high' });
    const inherit = await ctx.call('laptop', 'add-task', {
      body: { title: 'a', labels: ['research'], parentId: parent.id, createdBy: 'agent', status: 'needs-me' },
    });
    expect(inherit.json.result.task.priority).toBe('high');
    const chosen = await ctx.call('laptop', 'add-task', {
      body: {
        title: 'b',
        labels: ['research'],
        parentId: parent.id,
        createdBy: 'agent',
        status: 'needs-me',
        priority: 'low',
      },
    });
    expect(chosen.json.result.task.priority).toBe('low');
    const plain = await ctx.call('laptop', 'add-task', { body: { title: 'c', labels: ['research'] } });
    expect(plain.json.result.task.priority).toBe('normal');
  });
});

describe('lanes, liveness and pausing', () => {
  let sessions = 0;
  async function running(title: string, priority: 'urgent' | 'high' | 'normal' | 'low' = 'normal') {
    const task = await plainUi(db).tasks.create({ title, input: 'do it', priority });
    await ctx.call('laptop', 'claim-task', { id: task.id, machine: 'laptop' });
    await ctx.call('laptop', 'update-task', { id: task.id, body: { sessionId: sessionNamed((sessions += 1)) } });
    return task.id;
  }

  it('a heartbeat shows the lane and liveness while the task runs, and nothing after', async () => {
    const id = await running('t');
    expect((await ctx.call('laptop', 'heartbeat', { id, body: { lane: 'a b', borrowed: false } })).status).toBe(400);
    await ctx.call('laptop', 'heartbeat', { id, body: { lane: 'implement', borrowed: true } });
    const task = (await ctx.call('laptop', 'get-task', { id })).json.result;
    expect(task).toMatchObject({ lane: 'implement', borrowed: true });
    expect(Date.now() - new Date(task.lastActiveAt).getTime()).toBeLessThan(5_000);
    await ctx.call('laptop', 'update-task', { id, body: { status: 'needs-me' } });
    expect((await ctx.call('laptop', 'get-task', { id })).json.result).toMatchObject({
      lane: null,
      borrowed: false,
      lastActiveAt: null,
    });
    // A late heartbeat from a stopping worker does not bring the run back.
    await ctx.call('laptop', 'heartbeat', { id, body: { lane: 'implement', borrowed: true } });
    expect((await ctx.call('laptop', 'get-task', { id })).json.result.lane).toBeNull();
  });

  it('a paused task resumes next, on its machine, ahead of new urgent work', async () => {
    const ui = plainUi(db);
    const id = await running('paused', 'low');
    await ui.tasks.create({ title: 'urgent', input: 'do it', priority: 'urgent' });
    const paused = await ctx.call('laptop', 'pause', {
      id,
      body: 'Paused on laptop: the reviews lane needed its slot.',
    });
    expect(paused.json.result).toMatchObject({ status: 'todo', next: 'resume', machine: 'laptop' });
    const list = await ui.tasks.list();
    expect(list.filter((t) => t.status === 'todo').map((t) => [t.title, t.paused])).toEqual([
      ['paused', true],
      ['urgent', false],
    ]);
    expect((await ctx.call('laptop', 'pause', { id, body: 'again' })).status).toBe(409);
    expect((await ctx.call('workstation', 'claim-task', { id, machine: 'workstation' })).status).toBe(409);
    const claimed = await ctx.call('laptop', 'claim-task', { id, machine: 'laptop' });
    // The worker that resumes it still sees the pause until its first update of the run.
    expect(claimed.json.result).toMatchObject({ status: 'running', paused: true });
    await ctx.call('laptop', 'update-task', { id, body: { next: 'fresh' } });
    expect((await ctx.call('laptop', 'get-task', { id })).json.result.paused).toBe(false);
    const { thread } = await ui.tasks.get({ id });
    expect(thread.some((n) => n.author === 'system' && n.text.startsWith('Paused on laptop'))).toBe(true);
  });
});

describe('prompts', () => {
  it('a task is titled by its first line by the client, carries no labels, and can be pinned', async () => {
    const ui = plainUi(db);
    const review = await ui.tasks.create({ input: '/review-pr 17741\nplease look at the migration' });
    expect(review).toMatchObject({
      title: '/review-pr 17741',
      createdBy: 'user',
      machine: null,
      workdir: null,
    });
    expect(review).not.toHaveProperty('labels');
    const pinned = await ctx.call('laptop', 'add-task', {
      body: { title: 't', input: '/grill', machine: 'laptop', workdir: '/home/me/repo' },
    });
    expect(pinned.json.result.task).toMatchObject({ machine: 'laptop', workdir: '/home/me/repo' });
  });
});

describe('transcripts', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 13, 12, 0, s)).toISOString();
  const batch = (runId: string, events: unknown[]) => ({
    runId,
    startedAt: at(0),
    sessionId: '7c1e2f0a-3b4d-4e5f-8a9b-0c1d2e3f4a5b',
    resumed: false,
    events,
  });
  const events = [
    { seq: 0, at: at(1), parent: null, kind: 'note', text: 'Claude Code 2.1.325' },
    { seq: 1, at: at(2), parent: null, kind: 'tool_use', toolUseId: 'tu1', name: 'Bash', input: { command: 'ls' } },
    { seq: 2, at: at(3), parent: null, kind: 'tool_result', toolUseId: 'tu1', isError: false, output: 'a.txt\nb.txt' },
  ];

  it('stores batches once, lists runs and events without output, and loads output on demand', async () => {
    const ui = plainUi(db);
    const task = await ui.tasks.create({ input: '/grill' });
    const body = batch('run-0001-aaaa', events);
    expect((await ctx.call('laptop', 'transcript', { id: task.id, body })).status).toBe(200);
    expect((await ctx.call('laptop', 'transcript', { id: task.id, body })).status).toBe(200);
    await ctx.call('laptop', 'transcript', {
      id: task.id,
      body: batch('run-0001-aaaa', [{ seq: 3, at: at(9), parent: null, kind: 'text', text: 'done' }]),
    });
    const [run] = await ui.transcript.runs({ id: task.id });
    expect(run).toMatchObject({
      id: 'run-0001-aaaa',
      machine: 'laptop',
      eventCount: 4,
      sessionId: '7c1e2f0a-3b4d-4e5f-8a9b-0c1d2e3f4a5b',
    });
    expect(run?.lastEventAt.toISOString()).toBe(at(9));
    const listed = await ui.transcript.events({ taskId: task.id, runId: 'run-0001-aaaa' });
    expect(listed.map((e) => e.kind)).toEqual(['note', 'tool_use', 'tool_result', 'text']);
    expect(listed[2]).toMatchObject({ outputSize: 11 });
    expect(listed[2]).not.toHaveProperty('output');
    expect(
      (await ui.transcript.events({ taskId: task.id, runId: 'run-0001-aaaa', afterSeq: 2 })).map((e) => e.seq),
    ).toEqual([3]);
    expect(await ui.transcript.output({ taskId: task.id, runId: 'run-0001-aaaa', seq: 2 })).toBe('a.txt\nb.txt');
    const other = await ui.tasks.create({ input: '/other' });
    expect((await ctx.call('laptop', 'transcript', { id: other.id, body })).status).toBe(400);
    // The server may show the run under another task, but its events are sealed for this one and do not open there.
    await expect(ui.transcript.events({ taskId: other.id, runId: 'run-0001-aaaa' })).rejects.toThrow();
    await expect(ui.transcript.output({ taskId: other.id, runId: 'run-0001-aaaa', seq: 2 })).rejects.toThrow();
    expect((await ctx.call('laptop', 'transcript', { id: task.id, body: { ...body, runId: '../x' } })).status).toBe(
      400,
    );
  });

  it('keeps context readings out of the event list and count, and serves the newest run’s latest one', async () => {
    const ui = plainUi(db);
    const task = await ui.tasks.create({ input: '/grill' });
    const reading = (seq: number, used: number) => ({
      seq,
      at: at(seq + 1),
      parent: null,
      kind: 'context',
      used,
      window: 1_000_000,
      threshold: null,
      model: 'claude-opus-4-7',
    });
    const first = batch('run-ctx-00001', [
      { seq: 0, at: at(1), parent: null, kind: 'text', text: 'hello' },
      reading(1, 1000),
      reading(3, 3000),
    ]);
    expect((await ctx.call('laptop', 'transcript', { id: task.id, body: first })).status).toBe(200);
    expect((await ui.transcript.runs({ id: task.id }))[0]).toMatchObject({ id: 'run-ctx-00001', eventCount: 1 });
    expect((await ui.transcript.events({ taskId: task.id, runId: 'run-ctx-00001' })).map((e) => e.kind)).toEqual([
      'text',
    ]);
    expect(await ui.transcript.context({ id: task.id })).toMatchObject({
      runId: 'run-ctx-00001',
      seq: 3,
      kind: 'context',
      used: 3000,
    });
    expect(await plainUi(db, 'other').transcript.context({ id: task.id })).toBeNull();
    const second = {
      ...batch('run-ctx-00002', [{ seq: 0, at: at(20), parent: null, kind: 'text', text: 'again' }]),
      startedAt: at(10),
    };
    await ctx.call('laptop', 'transcript', { id: task.id, body: second });
    expect(await ui.transcript.context({ id: task.id })).toBeNull();
  });

  it('refuses an event with a bad seq or date instead of failing in the database', async () => {
    const task = await plainUi(db).tasks.create({ input: '/grill' });
    for (const bad of [{ seq: -1 }, { seq: 1.5 }, { seq: 2 ** 31 }, { at: 'soon' }, { parent: 'a b' }]) {
      const body = batch('run-bad-00001', [{ ...events[0], ...bad }]);
      expect((await ctx.call('laptop', 'transcript', { id: task.id, body })).status).toBe(400);
    }
  });

  it('transcripts of open tasks untouched in Done for 28 days are deleted, others stay', async () => {
    const ui = plainUi(db);
    const stale = await ui.tasks.create({ input: '/stale', when: 'hold' });
    const fresh = await ui.tasks.create({ input: '/fresh', when: 'hold' });
    const running = await ui.tasks.create({ input: '/running', when: 'hold' });
    for (const [task, run] of [
      [stale, 'run-stale-001'],
      [fresh, 'run-fresh-001'],
      [running, 'run-runnin-01'],
    ] as const) {
      await ctx.call('laptop', 'transcript', { id: task.id, body: batch(run, events) });
    }
    await ui.tasks.done({ id: stale.id });
    await ui.tasks.done({ id: fresh.id });
    const idle = (id: string, days: number) =>
      admin
        .update(tasks)
        .set({ updatedAt: new Date(Date.now() - days * 24 * 60 * 60_000) })
        .where(eq(tasks.id, id));
    await idle(stale.id, 29);
    await idle(fresh.id, 27);
    await idle(running.id, 29);
    const { deleteOldTranscripts } = await import('./services/transcripts');
    expect(await asOwner(db, 'jascha', (tx) => deleteOldTranscripts(tx))).toBe(1);
    expect(await ui.transcript.runs({ id: stale.id })).toHaveLength(0);
    expect(await ui.transcript.runs({ id: fresh.id })).toHaveLength(1);
    expect(await ui.transcript.runs({ id: running.id })).toHaveLength(1);
  });

  it('transcripts of tasks closed more than 14 days ago are deleted, others stay', async () => {
    const ui = plainUi(db);
    const old = await ui.tasks.create({ input: '/old' });
    const recent = await ui.tasks.create({ input: '/recent' });
    const open = await ui.tasks.create({ input: '/open' });
    for (const [task, run] of [
      [old, 'run-old-0001'],
      [recent, 'run-recent-01'],
      [open, 'run-open-0001'],
    ] as const) {
      await ctx.call('laptop', 'transcript', { id: task.id, body: batch(run, events) });
    }
    await ui.tasks.setClosed({ id: old.id, closed: true });
    await ui.tasks.setClosed({ id: recent.id, closed: true });
    const { deleteOldTranscripts } = await import('./services/transcripts');
    const { tasks } = await import('./db/schema');
    const { eq } = await import('drizzle-orm');
    await admin
      .update(tasks)
      .set({ closedAt: new Date(Date.now() - 15 * 24 * 60 * 60_000) })
      .where(eq(tasks.id, old.id));
    expect(await asOwner(db, 'jascha', (tx) => deleteOldTranscripts(tx))).toBe(1);
    expect(await ui.transcript.runs({ id: old.id })).toHaveLength(0);
    expect(await ui.transcript.runs({ id: recent.id })).toHaveLength(1); // closed today: kept
    expect(await ui.transcript.runs({ id: open.id })).toHaveLength(1);
    await ui.tasks.setClosed({ id: recent.id, closed: false });
    expect((await ui.tasks.get({ id: recent.id })).task.closed).toBe(false);
  });
});

describe('proposals', () => {
  const propose = async (body: Record<string, unknown> = {}) =>
    (await ctx.call('laptop', 'add-task', { body: { title: 'idea', input: 'do Y', createdBy: 'agent', ...body } })).json
      .result.task;

  it('an agent task lands in backlog as a proposal whatever start status it names', async () => {
    for (const status of ['backlog', 'todo', 'needs-me']) {
      expect(await propose({ status })).toMatchObject({ status: 'backlog', createdBy: 'agent' });
    }
    expect((await plainUi(db).tasks.list()).every((t) => t.proposed)).toBe(true);
  });

  it('the machine API cannot start a proposal; the user can', async () => {
    const { id } = await propose();
    for (const status of ['todo', 'done']) {
      const refused = await ctx.call('laptop', 'update-task', { id, body: { status } });
      expect(refused.status).toBe(403);
    }
    // Other fields are fine, and so is staying put.
    expect(
      (await ctx.call('laptop', 'update-task', { id, body: { status: 'backlog', sessionId: SESSION } })).status,
    ).toBe(200);
    expect((await ctx.call('laptop', 'claim-task', { id, machine: 'laptop' })).status).toBe(409);
    // Even a proposal that somehow sits in Todo is not claimable.
    await admin.update(tasks).set({ status: 'todo' }).where(eq(tasks.id, id));
    expect((await ctx.call('laptop', 'claim-task', { id, machine: 'laptop' })).status).toBe(409);
    await admin.update(tasks).set({ status: 'backlog' }).where(eq(tasks.id, id));
    const started = await plainUi(db).tasks.move({ id, status: 'todo' });
    expect(started).toMatchObject({ status: 'todo', proposed: false, createdBy: 'user' });
    expect((await ctx.call('laptop', 'claim-task', { id, machine: 'laptop' })).status).toBe(200);
  });

  it('starting a proposal is the user’s sealed act: the prompt sealed again for the creator "user", and nothing else starts it', async () => {
    const ui = plainUi(db);
    const { id } = await propose({ input: 'do Y' });
    const raw = ui.raw;
    // Without the prompt sealed again, a move into Todo is refused, and so is every other way into Todo.
    await expect(raw.tasks.move({ id, status: 'todo' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      raw.tasks.reply({
        id,
        message: await sealNote(sealed.seal, { taskId: id, author: 'user', kind: 'comment' }, 'go'),
        resume: true,
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(raw.tasks.rerun({ id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await raw.tasks.done({ id });
    await expect(raw.tasks.move({ id, status: 'todo' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await raw.tasks.setClosed({ id, closed: true });
    await raw.tasks.setClosed({ id, closed: false });
    expect(await ui.tasks.get({ id })).toMatchObject({ task: { proposed: true, createdBy: 'agent' } });
    // A prompt that is not an envelope is no start.
    await expect(raw.tasks.move({ id, status: 'todo', startInput: 'do Y' })).rejects.toThrow();
    // A prompt sealed for the creator agent is accepted by the server, which cannot tell: the worker will not open it as a user's.
    const [stored] = await admin.select().from(tasks).where(eq(tasks.id, id));
    const sealedAsAgent = stored!.input;
    await raw.tasks.move({ id, status: 'todo', startInput: sealedAsAgent });
    const [started] = await admin.select().from(tasks).where(eq(tasks.id, id));
    expect(started).toMatchObject({ createdBy: 'user', proposed: false, status: 'todo' });
    expect(
      await sealed.open(
        inputBinding({ kind: 'task', id, createdBy: 'user', scheduleId: null, forkOf: null }),
        started!.input,
      ),
    ).toBeUndefined();
    // The server cannot tell, so it claims; the worker finds the prompt unreadable as a user's and refuses it.
    const claimed = await ctx.raw('laptop', 'claim-task', { id, machine: 'laptop' });
    expect(claimed.status).toBe(200);
    expect(claimed.json.result.createdBy).toBe('user');
  });

  it('a task that names an agent as its creator is not claimable even when it is no longer marked proposed', async () => {
    const { id } = await propose();
    await admin.update(tasks).set({ status: 'todo', proposed: false }).where(eq(tasks.id, id));
    expect((await ctx.call('laptop', 'claim-task', { id, machine: 'laptop' })).status).toBe(409);
  });

  it('a proposal cannot ask a question, so answering never starts it', async () => {
    const { id } = await propose();
    const asked = await ctx.call('laptop', 'ask', { id, body: { questions: [question] } });
    expect(asked.status).toBe(403);
    expect(asked.json.error).toMatch(/only you start it/);
    const { task, thread } = await plainUi(db).tasks.get({ id });
    expect(task).toMatchObject({ status: 'backlog', proposed: true, openQuestion: false });
    expect(thread.filter((n) => n.kind === 'question')).toEqual([]);
  });
});

describe('transitions', () => {
  async function asking(options: { session?: boolean } = {}) {
    const ui = plainUi(db);
    const task = await ui.tasks.create({ title: 't', input: 'do it' });
    await ctx.call('laptop', 'claim-task', { id: task.id, machine: 'laptop' });
    if (options.session ?? true) await ctx.call('laptop', 'update-task', { id: task.id, body: { sessionId: SESSION } });
    await ctx.call('laptop', 'ask', { id: task.id, body: { questions: [question] } });
    expect((await ui.tasks.get({ id: task.id })).task.openQuestion).toBe(true);
    return task.id;
  }

  it('marking done and dragging to Done both close the open question', async () => {
    const ui = plainUi(db);
    expect(await ui.tasks.done({ id: await asking() })).toMatchObject({ status: 'done', openQuestion: false });
    expect(await ui.tasks.move({ id: await asking(), status: 'done' })).toMatchObject({
      status: 'done',
      openQuestion: false,
    });
  });

  it('dragging to Todo drops the open question and leaves a session its next run', async () => {
    const ui = plainUi(db);
    const id = await asking();
    const before = (await ui.tasks.get({ id })).task;
    const moved = await ui.tasks.move({ id, status: 'todo' });
    expect(moved).toMatchObject({ status: 'todo', openQuestion: false, next: before.next, sessionId: SESSION });
  });

  it('an intake requeue with a fresh run and a re-run drop the open question', async () => {
    const ui = plainUi(db);
    const requeued = await ctx.call('laptop', 'update-task', {
      id: await asking(),
      body: { status: 'todo', next: 'fresh' },
    });
    expect(requeued.json.result).toMatchObject({ status: 'todo', next: 'fresh', openQuestion: false });
    expect(await ui.tasks.rerun({ id: await asking() })).toMatchObject({ status: 'todo', openQuestion: false });
  });

  it('a question stays open only in Needs me: moving around there keeps it', async () => {
    const ui = plainUi(db);
    const id = await asking();
    expect(await ui.tasks.setPriority({ id, priority: 'high' })).toMatchObject({
      status: 'needs-me',
      openQuestion: true,
    });
    expect(await ui.tasks.move({ id, status: 'needs-me' })).toMatchObject({ openQuestion: true });
  });

  it('records the run start while it runs, and nothing after', async () => {
    const ui = plainUi(db);
    const task = await ui.tasks.create({ title: 't', input: 'do it' });
    expect((await ctx.call('laptop', 'get-task', { id: task.id })).json.result.runStartedAt).toBeNull();
    const claimed = (await ctx.call('laptop', 'claim-task', { id: task.id, machine: 'laptop' })).json.result;
    expect(Date.now() - new Date(claimed.runStartedAt).getTime()).toBeLessThan(5_000);
    await ctx.call('laptop', 'update-task', { id: task.id, body: { status: 'needs-me' } });
    expect((await ctx.call('laptop', 'get-task', { id: task.id })).json.result.runStartedAt).toBeNull();
  });

  it('a pause is cleared when the task leaves Running another way', async () => {
    const ui = plainUi(db);
    const task = await ui.tasks.create({ title: 't', input: 'do it' });
    await ctx.call('laptop', 'claim-task', { id: task.id, machine: 'laptop' });
    await ctx.call('laptop', 'pause', { id: task.id, body: 'Paused on laptop' });
    await ctx.call('laptop', 'claim-task', { id: task.id, machine: 'laptop' });
    await ctx.call('laptop', 'ask', { id: task.id, body: { questions: [question] } });
    expect((await ctx.call('laptop', 'get-task', { id: task.id })).json.result.paused).toBe(false);
  });
});

describe('a question from a run that no longer holds the task', () => {
  async function running() {
    const task = await plainUi(db).tasks.create({ title: 't', input: 'do it' });
    await ctx.call('laptop', 'claim-task', { id: task.id, machine: 'laptop' });
    return task.id;
  }
  const ask = (id: string) => ctx.call('laptop', 'ask', { id, body: { questions: [question] } });

  it.each([
    ['done', 'the task is done, not running'],
    ['todo', 'the task is todo, not running'],
    ['needs-me', 'the task is needs-me, not running'],
  ] as const)('is refused once the task is %s, and changes nothing', async (status, error) => {
    const id = await running();
    await ctx.call('laptop', 'update-task', { id, body: { status } });
    const before = await plainUi(db).tasks.get({ id });
    expect(await ask(id)).toMatchObject({ status: 409, json: { error } });
    expect(await plainUi(db).tasks.get({ id })).toEqual(before);
  });

  it('is refused after the user took the run back', async () => {
    const id = await running();
    await admin
      .update(tasks)
      .set({ lastActiveAt: new Date(Date.now() - TAKE_BACK_AFTER_MS - 60_000) })
      .where(eq(tasks.id, id));
    await plainUi(db).tasks.takeBack({ id });
    expect(await ask(id)).toMatchObject({ status: 409, json: { error: 'the task is needs-me, not running' } });
    const { task, thread } = await plainUi(db).tasks.get({ id });
    expect(task.openQuestion).toBe(false);
    expect(thread.filter((n) => n.kind === 'question')).toEqual([]);
  });
});

describe('taking back a stuck task', () => {
  async function running() {
    const task = await plainUi(db).tasks.create({ title: 't', input: 'do it' });
    await ctx.call('laptop', 'claim-task', { id: task.id, machine: 'laptop' });
    return task.id;
  }
  const quietFor = (id: string, ms: number) =>
    admin
      .update(tasks)
      .set({ lastActiveAt: new Date(Date.now() - ms) })
      .where(eq(tasks.id, id));

  it('is refused while the agent is active, and for a task that is not running', async () => {
    const ui = plainUi(db);
    const id = await running();
    await quietFor(id, TAKE_BACK_AFTER_MS - 60_000);
    await expect(ui.tasks.takeBack({ id })).rejects.toThrow(/active 19 min ago/);
    await ctx.call('laptop', 'update-task', { id, body: { status: 'needs-me' } });
    await expect(ui.tasks.takeBack({ id })).rejects.toThrow(/not running/);
  });

  it('moves a task quiet for the limit to Needs me with a note; the worker then finds it reported', async () => {
    const ui = plainUi(db);
    const id = await running();
    await quietFor(id, TAKE_BACK_AFTER_MS + 1_000);
    const taken = await ui.tasks.takeBack({ id });
    expect(taken).toMatchObject({ status: 'needs-me', lane: null, lastActiveAt: null, runStartedAt: null });
    const { thread } = await ui.tasks.get({ id });
    expect(thread.at(-1)).toMatchObject({ author: 'server', kind: 'event' });
    expect(thread.at(-1)?.text).toMatch(/^Taken back from laptop/);
    // Nothing left to claim or fail for the worker that comes back.
    expect((await ctx.call('laptop', 'fail', { id, body: 'late' })).json.result.applied).toBe(false);
  });
});

describe('fail', () => {
  it('moves a running task to needs-me with the text as a system note, once', async () => {
    const ui = plainUi(db);
    const task = await ui.tasks.create({ title: 't', input: 'do it' });
    expect((await ctx.call('laptop', 'fail', { id: task.id, body: 'too early' })).json.result).toMatchObject({
      applied: false,
      task: { status: 'todo' },
    });
    await ctx.call('laptop', 'claim-task', { id: task.id, machine: 'laptop' });
    const failed = await ctx.call('laptop', 'fail', { id: task.id, body: 'The worker exited with code 1.' });
    expect(failed.json.result).toMatchObject({ applied: true, task: { status: 'needs-me', lane: null } });
    expect((await ctx.call('laptop', 'fail', { id: task.id, body: 'again' })).json.result.applied).toBe(false);
    const notes = (await ctx.call('laptop', 'read-notes', { id: task.id })).json.result;
    expect(notes.map((n: { text: string; author: string; kind: string }) => [n.author, n.kind, n.text])).toEqual([
      ['system', 'event', 'The worker exited with code 1.'],
    ]);
  });

  it('leaves a closed task alone', async () => {
    const ui = plainUi(db);
    const task = await ui.tasks.create({ title: 't', input: 'do it' });
    await ctx.call('laptop', 'claim-task', { id: task.id, machine: 'laptop' });
    await admin.update(tasks).set({ closed: true }).where(eq(tasks.id, task.id));
    expect((await ctx.call('laptop', 'fail', { id: task.id, body: 'x' })).json.result).toMatchObject({
      applied: false,
      task: { status: 'running' },
    });
  });
});

describe('head', () => {
  it('is a blind index: set by a draft, changed and cleared by a patch, and a plain sha is refused', async () => {
    const added = await ctx.call('laptop', 'add-task', { body: { title: 't', input: pr, head: 'abc1234' } });
    const id = added.json.result.task.id;
    expect(added.json.result.task.head).toBe(await sealed.headIndex('abc1234'));
    expect((await ctx.call('laptop', 'update-task', { id, body: { head: 'def56789ab' } })).json.result.head).toBe(
      await sealed.headIndex('def56789ab'),
    );
    expect((await ctx.call('laptop', 'update-task', { id, body: { head: null } })).json.result.head).toBeNull();
    const draft = {
      id: 'plain-head-1',
      ...(await sealFields(
        sealed.seal,
        { kind: 'task', id: 'plain-head-1', createdBy: 'user', scheduleId: null, forkOf: null },
        { title: 't', input: 'x' },
      )),
    };
    expect((await ctx.raw('laptop', 'update-task', { id, body: { head: 'abc1234' } })).status).toBe(400);
    expect((await ctx.raw('laptop', 'update-task', { id, body: { head: 'nothex!' } })).status).toBe(400);
    expect((await ctx.raw('laptop', 'add-task', { body: { ...draft, head: 'abc1234' } })).status).toBe(400);
  });

  it('is cleared together with a status change', async () => {
    const added = await ctx.call('laptop', 'add-task', { body: { title: 't', input: pr, head: 'abc1234' } });
    const id = added.json.result.task.id;
    const done = await ctx.call('laptop', 'update-task', { id, body: { status: 'done', head: null } });
    expect(done.json.result).toMatchObject({ status: 'done', head: null });
  });
});

describe('the board list', () => {
  it('carries the newest note of each task, and null for a task without notes', async () => {
    const ui = plainUi(db);
    const quiet = await ui.tasks.create({ title: 'quiet', input: 'do it' });
    const busy = await ui.tasks.create({ title: 'busy', input: 'do it' });
    await ctx.call('laptop', 'add-note', { id: busy.id, body: 'first' });
    await ctx.call('laptop', 'add-note', { id: busy.id, body: 'x'.repeat(1000) });
    const list = await ui.tasks.list();
    expect(list.find((t) => t.id === quiet.id)?.lastNote).toBeNull();
    const last = list.find((t) => t.id === busy.id)?.lastNote;
    expect(last).toMatchObject({ kind: 'comment', author: 'agent' });
    expect(last?.text).toHaveLength(300);
  });
});

describe('update-task expect', () => {
  it('writes only while the task has the expected status, and answers 409 without a write otherwise', async () => {
    const ui = plainUi(db);
    const task = await ui.tasks.create({ title: 't', input: 'do it' });
    const refused = await ctx.call('laptop', 'update-task', {
      id: task.id,
      body: { status: 'done', head: null, expect: 'needs-me' },
    });
    expect(refused.status).toBe(409);
    expect((await ui.tasks.get({ id: task.id })).task.status).toBe('todo');
    const applied = await ctx.call('laptop', 'update-task', {
      id: task.id,
      body: { priority: 'high', expect: 'todo' },
    });
    expect(applied.status).toBe(200);
    expect(applied.json.result.priority).toBe('high');
    expect((await ctx.call('laptop', 'update-task', { id: task.id, body: { expect: 'nope' } })).status).toBe(400);
  });
});

describe('Done archival', () => {
  const idle = (id: string, days: number) =>
    admin
      .update(tasks)
      .set({ updatedAt: new Date(Date.now() - days * 24 * 60 * 60_000) })
      .where(eq(tasks.id, id));

  it('closes tasks untouched in Done for 7 days, with a note, and nothing else', async () => {
    const ui = plainUi(db);
    const old = await ui.tasks.create({ title: 'old', input: 'do it', when: 'hold' });
    const recent = await ui.tasks.create({ title: 'recent', input: 'do it', when: 'hold' });
    const waiting = await ui.tasks.create({ title: 'waiting', input: 'do it', when: 'hold' });
    await ui.tasks.done({ id: old.id });
    await ui.tasks.done({ id: recent.id });
    await idle(old.id, 8);
    await idle(recent.id, 6);
    await idle(waiting.id, 30);
    expect(await asOwner(db, 'jascha', (tx) => archiveStaleDone(tx))).toBe(1);
    const closed = (await ui.tasks.get({ id: old.id })).task;
    expect(closed).toMatchObject({ closed: true, status: 'done' });
    expect((await ui.tasks.get({ id: old.id })).thread.at(-1)?.text).toBe('Closed after 7 days in Done.');
    expect((await ui.tasks.get({ id: recent.id })).task.closed).toBe(false);
    expect((await ui.tasks.get({ id: waiting.id })).task.closed).toBe(false);
    expect(await asOwner(db, 'jascha', (tx) => archiveStaleDone(tx))).toBe(0);
    // Its transcripts now go after the usual retention.
    expect((await admin.select().from(tasks).where(eq(tasks.id, old.id)))[0]?.closedAt).not.toBeNull();
  });

  it('leaves intake tasks open, so a re-requested review is not blocked', async () => {
    const added = await ctx.call('laptop', 'add-task', {
      body: { title: 'review', input: '/review-pr x', createdBy: 'intake' },
    });
    const id = added.json.result.task.id;
    await admin.update(tasks).set({ status: 'done' }).where(eq(tasks.id, id));
    await idle(id, 40);
    expect(await asOwner(db, 'jascha', (tx) => archiveStaleDone(tx))).toBe(0);
    expect((await plainUi(db).tasks.get({ id })).task.closed).toBe(false);
  });

  it('leaves tasks with a dedupe key open, whoever made them', async () => {
    const added = await ctx.call('laptop', 'add-task', {
      body: { title: 'keyed', input: '/review-pr y', dedupeKey: 'https://github.com/o/r/pull/9' },
    });
    const id = added.json.result.task.id;
    await admin.update(tasks).set({ status: 'done' }).where(eq(tasks.id, id));
    await idle(id, 40);
    expect(await asOwner(db, 'jascha', (tx) => archiveStaleDone(tx))).toBe(0);
    expect((await plainUi(db).tasks.get({ id })).task.closed).toBe(false);
  });
});

describe('delayed tasks', () => {
  const soon = () => new Date(Date.now() + 3_600_000);
  const claim = (id: string) => ctx.call('laptop', 'claim-task', { id, machine: 'laptop' });

  it('a delayed task is 409 on claim until due, then claimable; the claim clears the delay', async () => {
    const ui = plainUi(db);
    const { id } = await ui.tasks.create({ input: 'later', when: { at: soon() } });
    expect((await claim(id)).status).toBe(409);
    await admin
      .update(tasks)
      .set({ notBefore: new Date(Date.now() - 1000) })
      .where(eq(tasks.id, id));
    const claimed = await claim(id);
    expect(claimed.status).toBe(200);
    expect(claimed.json.result).toMatchObject({ status: 'running', notBefore: null });
  });

  it('tasks.create takes {at} and the machine API takes notBefore in a draft', async () => {
    const ui = plainUi(db);
    const at = soon();
    expect(await ui.tasks.create({ input: 'a', when: { at } })).toMatchObject({ status: 'todo', notBefore: at });
    const added = await ctx.call('laptop', 'add-task', { body: { title: 't', notBefore: at.toISOString() } });
    expect(added.json.result.task.notBefore).toBe(at.toISOString());
    const parked = await ctx.call('laptop', 'add-task', {
      body: { title: 't', status: 'backlog', notBefore: at.toISOString() },
    });
    expect(parked.status).toBe(400);
    const proposed = await ctx.call('laptop', 'add-task', {
      body: { title: 't', createdBy: 'agent', notBefore: at.toISOString() },
    });
    expect(proposed.status).toBe(400);
  });

  it('tasks.setNotBefore sets, moves and clears the delay of a Todo task', async () => {
    const ui = plainUi(db);
    const { id } = await ui.tasks.create({ input: 'a' });
    const at = soon();
    expect(await ui.tasks.setNotBefore({ id, notBefore: at })).toMatchObject({ notBefore: at });
    expect((await claim(id)).status).toBe(409);
    expect(await ui.tasks.setNotBefore({ id, notBefore: null })).toMatchObject({ notBefore: null });
    expect((await claim(id)).status).toBe(200);
  });

  it('a delay cannot be set on a task that is not in Todo', async () => {
    const ui = plainUi(db);
    const { id } = await ui.tasks.create({ input: 'a', when: 'backlog' });
    await expect(ui.tasks.setNotBefore({ id, notBefore: soon() })).rejects.toThrow(/not in Todo/);
    const patched = await ctx.call('laptop', 'update-task', { id, body: { notBefore: soon().toISOString() } });
    expect(patched.status).toBe(409);
    const requeued = await ctx.call('laptop', 'update-task', {
      id,
      body: { status: 'todo', notBefore: soon().toISOString() },
    });
    expect(requeued.json.result).toMatchObject({ status: 'todo' });
    expect(requeued.json.result.notBefore).not.toBeNull();
    const todo = await ui.tasks.create({ input: 'b' });
    const moving = await ctx.call('laptop', 'update-task', {
      id: todo.id,
      body: { status: 'done', notBefore: soon().toISOString() },
    });
    expect(moving.status).toBe(409);
  });

  it('update-task sets and clears notBefore', async () => {
    const { id } = await plainUi(db).tasks.create({ input: 'a' });
    const at = soon();
    const set = await ctx.call('laptop', 'update-task', { id, body: { notBefore: at.toISOString() } });
    expect(set.json.result.notBefore).toBe(at.toISOString());
    const cleared = await ctx.call('laptop', 'update-task', { id, body: { notBefore: null } });
    expect(cleared.json.result.notBefore).toBeNull();
  });

  it('leaving Todo clears the delay', async () => {
    const ui = plainUi(db);
    const { id } = await ui.tasks.create({ input: 'a', when: { at: soon() } });
    await ui.tasks.move({ id, status: 'backlog' });
    expect((await admin.select().from(tasks).where(eq(tasks.id, id)))[0]?.notBefore).toBeNull();
    await ui.tasks.move({ id, status: 'todo' });
    expect((await ui.tasks.get({ id })).task.notBefore).toBeNull();
    const second = await ui.tasks.create({ input: 'b', when: { at: soon() } });
    const done = await ctx.call('laptop', 'update-task', { id: second.id, body: { status: 'done' } });
    expect(done.json.result).toMatchObject({ status: 'done', notBefore: null });
  });

  it('waiting cards sort last in Todo, by start; once due they sort like any other', async () => {
    const ui = plainUi(db);
    const hour = 3_600_000;
    await ui.tasks.create({
      title: 'late',
      input: 'a',
      priority: 'urgent',
      when: { at: new Date(Date.now() + 2 * hour) },
    });
    const early = await ui.tasks.create({
      title: 'early',
      input: 'a',
      priority: 'urgent',
      when: { at: new Date(Date.now() + hour) },
    });
    await ui.tasks.create({ title: 'low', input: 'a', priority: 'low' });
    await ui.tasks.create({ title: 'normal', input: 'a' });
    const titles = async () => (await ui.tasks.list()).map((t) => t.title);
    expect(await titles()).toEqual(['normal', 'low', 'early', 'late']);
    await admin
      .update(tasks)
      .set({ notBefore: new Date(Date.now() - 1000) })
      .where(eq(tasks.id, early.id));
    expect(await titles()).toEqual(['early', 'normal', 'low', 'late']);
  });
});

describe('schedules', () => {
  const hour = 3_600_000;
  const claim = (id: string) => ctx.call('laptop', 'claim-task', { id, machine: 'laptop' });
  const addSchedule = (body: Record<string, unknown>) =>
    ctx.call('laptop', 'add-schedule', { body: { title: 'Sweep', input: '/sweep', everyMs: hour, ...body } });
  const scheduled = (scheduleId: string) =>
    admin.select().from(tasks).where(eq(tasks.scheduleId, scheduleId)).orderBy(tasks.createdAt);
  const makeDue = (id: string) =>
    admin
      .update(tasks)
      .set({ notBefore: new Date(Date.now() - 1000) })
      .where(eq(tasks.id, id));
  const listed = async () => (await ctx.call('laptop', 'list-schedules')).json.result as any[];

  it('adding a schedule creates one waiting Todo card, pinned like the schedule', async () => {
    const startAt = new Date(Date.now() + 2 * hour);
    const { status, json } = await addSchedule({
      startAt: startAt.toISOString(),
      priority: 'high',
      machine: 'laptop',
      workdir: '/work/x',
    });
    expect(status).toBe(200);
    expect(json.result.task).toMatchObject({
      status: 'todo',
      title: 'Sweep',
      input: '/sweep',
      priority: 'high',
      createdBy: 'user',
      machine: 'laptop',
      workdir: '/work/x',
      notBefore: startAt.toISOString(),
      scheduleId: json.result.schedule.id,
    });
    expect(json.result.schedule).toMatchObject({
      everyMs: hour,
      remaining: null,
      paused: false,
      ended: false,
      nextRunAt: startAt.toISOString(),
      occurrenceTaskId: json.result.task.id,
    });
    expect(await scheduled(json.result.schedule.id)).toHaveLength(1);
    expect(await listed()).toHaveLength(1);
  });

  it('a schedule keeps its model and every card it creates inherits it', async () => {
    const { json } = await addSchedule({ model: 'claude-opus-5-5', times: 3 });
    expect(json.result.schedule.model).toBe('claude-opus-5-5');
    expect(json.result.task.model).toBe('claude-opus-5-5');
    expect((await listed())[0]).toMatchObject({ model: 'claude-opus-5-5' });
    expect((await claim(json.result.task.id)).status).toBe(200);
    const [, second] = await scheduled(json.result.schedule.id);
    expect(second?.model).toBe('claude-opus-5-5');
    const plain = await addSchedule({});
    expect(plain.json.result).toMatchObject({ schedule: { model: null }, task: { model: null } });
  });

  it('a model that is not a model name is refused, for a schedule and a task', async () => {
    for (const model of ['--x', 'a b', '', null, 5]) {
      expect((await addSchedule({ model })).status, JSON.stringify(model)).toBe(400);
      const refused = await ctx.call('laptop', 'add-task', { body: { title: 't', input: 'x', model } });
      expect(refused.status, JSON.stringify(model)).toBe(400);
    }
  });

  it('a schedule keeps its effort and every card it creates inherits it', async () => {
    const { json } = await addSchedule({ effort: 'xhigh', times: 3 });
    expect(json.result.schedule.effort).toBe('xhigh');
    expect(json.result.task.effort).toBe('xhigh');
    expect((await listed())[0]).toMatchObject({ effort: 'xhigh' });
    expect((await claim(json.result.task.id)).status).toBe(200);
    const [, second] = await scheduled(json.result.schedule.id);
    expect(second?.effort).toBe('xhigh');
    const plain = await addSchedule({});
    expect(plain.json.result).toMatchObject({ schedule: { effort: null }, task: { effort: null } });
  });

  it('an effort that is not a level is refused, for a schedule and a task', async () => {
    for (const effort of ['--x', 'huge', 'High', '', null, 5]) {
      expect((await addSchedule({ effort })).status, JSON.stringify(effort)).toBe(400);
      const refused = await ctx.call('laptop', 'add-task', { body: { title: 't', input: 'x', effort } });
      expect(refused.status, JSON.stringify(effort)).toBe(400);
    }
  });

  it('a task made through the machine API or the browser keeps its effort; none is the default', async () => {
    const viaApi = await ctx.call('laptop', 'add-task', { body: { title: 't', input: 'x', effort: 'medium' } });
    expect(viaApi.json.result.task.effort).toBe('medium');
    expect((await ctx.call('laptop', 'get-task', { id: viaApi.json.result.task.id })).json.result.effort).toBe(
      'medium',
    );
    expect(
      (await ctx.call('laptop', 'add-task', { body: { title: 't', input: 'x' } })).json.result.task.effort,
    ).toBeNull();
    const ui = plainUi(db);
    expect((await ui.tasks.create({ title: 'ui', input: 'x', effort: 'low' })).effort).toBe('low');
    expect((await ui.tasks.create({ title: 'ui', input: 'x' })).effort).toBeNull();
    const repeating = await ui.tasks.create({ title: 'ui', input: 'x', effort: 'max', when: { every: hour } });
    expect(repeating.effort).toBe('max');
    expect((await listed()).find((row) => row.id === repeating.scheduleId)).toMatchObject({ effort: 'max' });
    await expect(ui.tasks.create({ title: 'ui', input: 'x', effort: '--bad' as 'low' })).rejects.toThrow();
  });

  it('a task made through the machine API or the browser keeps its model; none is the default', async () => {
    const viaApi = await ctx.call('laptop', 'add-task', { body: { title: 't', input: 'x', model: 'sonnet' } });
    expect(viaApi.json.result.task.model).toBe('sonnet');
    expect((await ctx.call('laptop', 'get-task', { id: viaApi.json.result.task.id })).json.result.model).toBe('sonnet');
    expect(
      (await ctx.call('laptop', 'add-task', { body: { title: 't', input: 'x' } })).json.result.task.model,
    ).toBeNull();
    const ui = plainUi(db);
    expect((await ui.tasks.create({ title: 'ui', input: 'x', model: 'haiku' })).model).toBe('haiku');
    expect((await ui.tasks.create({ title: 'ui', input: 'x' })).model).toBeNull();
    const repeating = await ui.tasks.create({ title: 'ui', input: 'x', model: 'fable', when: { every: hour } });
    expect(repeating.model).toBe('fable');
    expect((await listed()).find((row) => row.id === repeating.scheduleId)).toMatchObject({ model: 'fable' });
    await expect(ui.tasks.create({ title: 'ui', input: 'x', model: '--bad' })).rejects.toThrow();
  });

  it('claiming the pending card creates the next one on the grid and counts down the runs', async () => {
    const { json } = await addSchedule({ times: 3 });
    const first = json.result.task;
    const anchor = new Date(first.notBefore).getTime();
    expect((await claim(first.id)).status).toBe(200);
    const [, second, ...rest] = await scheduled(json.result.schedule.id);
    expect(rest).toEqual([]);
    expect(second?.notBefore?.getTime()).toBe(anchor + hour);
    expect(second?.status).toBe('todo');
    expect((await listed())[0]).toMatchObject({ remaining: 1, occurrenceTaskId: second?.id });
  });

  it('times 2 gives exactly two cards and then the schedule has ended', async () => {
    const { json } = await addSchedule({ times: 2 });
    const id = json.result.schedule.id;
    await claim(json.result.task.id);
    const second = (await scheduled(id))[1]!;
    expect((await claim(second.id)).status).toBe(409);
    await makeDue(second.id);
    expect((await claim(second.id)).status).toBe(200);
    expect(await scheduled(id)).toHaveLength(2);
    expect((await listed())[0]).toMatchObject({ ended: true, nextRunAt: null, occurrenceTaskId: null, remaining: 0 });
  });

  it('skips the runs missed while nothing claimed the card', async () => {
    const anchor = Date.now() - 5.5 * hour;
    const { json } = await addSchedule({ startAt: new Date(anchor).toISOString() });
    expect((await claim(json.result.task.id)).status).toBe(200);
    const all = await scheduled(json.result.schedule.id);
    expect(all).toHaveLength(2);
    expect(all[1]?.notBefore?.getTime()).toBe(anchor + 6 * hour);
  });

  it('until ends the schedule when the next run would lie after it', async () => {
    const { json } = await addSchedule({ until: new Date(Date.now() + hour / 2).toISOString() });
    await claim(json.result.task.id);
    expect(await scheduled(json.result.schedule.id)).toHaveLength(1);
    expect((await listed())[0]).toMatchObject({ ended: true, occurrenceTaskId: null });
  });

  it('closing or moving the pending card skips that run and creates the next', async () => {
    const ui = plainUi(db);
    const { json } = await addSchedule({});
    const id = json.result.schedule.id;
    await ui.tasks.setClosed({ id: json.result.task.id, closed: true });
    const second = (await scheduled(id))[1]!;
    expect(second.notBefore?.getTime()).toBe(new Date(json.result.task.notBefore).getTime() + hour);
    await ui.tasks.move({ id: second.id, status: 'backlog' });
    const all = await scheduled(id);
    expect(all).toHaveLength(3);
    expect((await listed())[0]?.occurrenceTaskId).toBe(all[2]?.id);
  });

  it('a former occurrence that is queued again does not create another card', async () => {
    const { json } = await addSchedule({});
    const id = json.result.schedule.id;
    await claim(json.result.task.id);
    expect(await scheduled(id)).toHaveLength(2);
    await ctx.call('laptop', 'pause', { id: json.result.task.id, body: 'making room' });
    expect((await claim(json.result.task.id)).status).toBe(200);
    await ctx.call('laptop', 'pause', { id: json.result.task.id, body: 'again' });
    await plainUi(db).tasks.rerun({ id: json.result.task.id });
    expect(await scheduled(id)).toHaveLength(2);
  });

  it('two claims at once leave one next card', async () => {
    const { json } = await addSchedule({});
    const results = await Promise.all([claim(json.result.task.id), claim(json.result.task.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await scheduled(json.result.schedule.id)).toHaveLength(2);
  });

  it('pausing removes the pending card, resuming creates the next from now', async () => {
    const ui = plainUi(db);
    const { json } = await addSchedule({ times: 3, startAt: new Date(Date.now() + hour).toISOString() });
    const id = json.result.schedule.id;
    const paused = await ctx.call('laptop', 'update-schedule', { id, body: { paused: true } });
    expect(paused.json.result).toMatchObject({ paused: true, nextRunAt: null, occurrenceTaskId: null, remaining: 3 });
    expect(await scheduled(id)).toHaveLength(0);
    expect((await ctx.call('laptop', 'get-task', { id: json.result.task.id })).status).toBe(404);
    const resumed = await ui.schedules.setPaused({ id, paused: false });
    expect(resumed).toMatchObject({ paused: false, remaining: 2 });
    expect(resumed.nextRunAt).not.toBeNull();
    expect(await scheduled(id)).toHaveLength(1);
  });

  it('resuming a cron schedule before its start time waits for the start time', async () => {
    const ui = plainUi(db);
    const startAt = new Date(Date.now() + 3 * 24 * hour);
    const { json } = await ctx.call('laptop', 'add-schedule', {
      body: { title: 't', input: 'x', cron: '*/15 * * * *', timezone: 'UTC', startAt: startAt.toISOString() },
    });
    const id = json.result.schedule.id;
    await ui.schedules.setPaused({ id, paused: true });
    const resumed = await ui.schedules.setPaused({ id, paused: false });
    expect(resumed.nextRunAt?.getTime()).toBeGreaterThanOrEqual(startAt.getTime());
    expect(resumed.nextRunAt?.getTime()).toBeLessThan(startAt.getTime() + hour);
  });

  it('a paused schedule creates nothing when its pending card leaves Todo', async () => {
    const ui = plainUi(db);
    const { json } = await addSchedule({});
    const id = json.result.schedule.id;
    await admin.update(tasks).set({ sessionId: 'ran' }).where(eq(tasks.id, json.result.task.id));
    await ui.schedules.setPaused({ id, paused: true });
    expect(await scheduled(id)).toHaveLength(1);
    await ui.tasks.setClosed({ id: json.result.task.id, closed: true });
    expect(await scheduled(id)).toHaveLength(1);
    expect((await listed())[0]).toMatchObject({ paused: true, occurrenceTaskId: null });
    await ui.schedules.setPaused({ id, paused: false });
    expect(await scheduled(id)).toHaveLength(2);
  });

  it('reopening a closed pending card changes nothing: one pointer, the runs stay counted', async () => {
    const ui = plainUi(db);
    const { json } = await addSchedule({ times: 3 });
    const id = json.result.schedule.id;
    const first = json.result.task.id;
    await ui.tasks.setClosed({ id: first, closed: true });
    const second = (await scheduled(id))[1]!;
    expect((await listed())[0]).toMatchObject({ remaining: 1, occurrenceTaskId: second.id });
    await ui.tasks.setClosed({ id: first, closed: false });
    await ui.tasks.setClosed({ id: first, closed: true });
    expect(await scheduled(id)).toHaveLength(2);
    expect((await listed())[0]).toMatchObject({ remaining: 1, occurrenceTaskId: second.id });
  });

  it('nextRunAt follows the pending card: a changed delay, and run now', async () => {
    const ui = plainUi(db);
    const { json } = await addSchedule({ startAt: new Date(Date.now() + 2 * hour).toISOString() });
    const pending = json.result.task.id;
    const later = new Date(Date.now() + 5 * hour);
    await ui.tasks.setNotBefore({ id: pending, notBefore: later });
    expect((await listed())[0].nextRunAt).toBe(later.toISOString());
    expect((await ui.schedules.list())[0]?.nextRunAt).toEqual(later);
    await ui.tasks.setNotBefore({ id: pending, notBefore: null });
    expect((await listed())[0]).toMatchObject({ nextRunAt: null, occurrenceTaskId: pending });
  });

  it('lists the schedule whose pending card starts first on top, one that is due now before all', async () => {
    const far = (await addSchedule({ title: 'far', startAt: new Date(Date.now() + 9 * hour).toISOString() })).json;
    await addSchedule({ title: 'soon', startAt: new Date(Date.now() + 2 * hour).toISOString() });
    const ui = plainUi(db);
    const titles = async () => (await listed()).map((schedule) => schedule.title);
    expect(await titles()).toEqual(['soon', 'far']);
    await ui.tasks.setNotBefore({ id: far.result.task.id, notBefore: null });
    expect(await titles()).toEqual(['far', 'soon']);
  });

  it('removing a schedule deletes its pending card and leaves the cards that ran', async () => {
    const { json } = await addSchedule({});
    const id = json.result.schedule.id;
    await claim(json.result.task.id);
    const removed = await ctx.call('laptop', 'remove-schedule', { id });
    expect(removed.status).toBe(200);
    const left = await admin.select().from(tasks);
    expect(left.map((t) => [t.id, t.scheduleId])).toEqual([[json.result.task.id, id]]);
    expect(await admin.select().from(schedules)).toEqual([]);
    expect((await ctx.call('laptop', 'remove-schedule', { id })).status).toBe(404);
  });

  it('rejects what it cannot run', async () => {
    const cron = (pattern: string, timezone = 'Europe/Berlin') =>
      ctx.call('laptop', 'add-schedule', { body: { title: 't', input: 'x', cron: pattern, timezone } });
    expect((await cron('0 9 * * 1-5')).status).toBe(200);
    for (const bad of ['*/5 * * * * *', 'every day', '0 9 * *', '61 * * * *']) {
      const answer = await cron(bad);
      expect(answer.status, bad).toBe(400);
      expect(answer.json.error).toMatch(/cron/);
    }
    const zone = await cron('0 9 * * *', 'Mars/Base');
    expect(zone.status).toBe(400);
    expect(zone.json.error).toMatch(/time zone/);
    expect((await addSchedule({ everyMs: 1000 })).status).toBe(400);
    expect((await addSchedule({ cron: '0 9 * * *', timezone: 'UTC' })).status).toBe(400);
    expect((await addSchedule({ times: 2, until: new Date(Date.now() + hour).toISOString() })).status).toBe(400);
    expect(
      (await addSchedule({ startAt: new Date(Date.now() + 2 * hour).toISOString(), until: new Date().toISOString() }))
        .status,
    ).toBe(400);
    expect(await admin.select().from(schedules)).toHaveLength(1);
    expect(await admin.select().from(tasks)).toHaveLength(1);
  });

  it('a cron schedule starts at the first match from its start time', async () => {
    const startAt = new Date(Date.now() + 3 * hour);
    const { json } = await ctx.call('laptop', 'add-schedule', {
      body: { title: 't', input: 'x', cron: '*/15 * * * *', timezone: 'UTC', startAt: startAt.toISOString() },
    });
    const first = new Date(json.result.task.notBefore);
    expect(first.getTime()).toBeGreaterThanOrEqual(startAt.getTime());
    expect(first.getTime() - startAt.getTime()).toBeLessThan(15 * 60_000);
    expect(first.getUTCMinutes() % 15).toBe(0);
  });

  it('tasks.create makes a schedule from a repeat and returns its pending card', async () => {
    const ui = plainUi(db);
    const task = await ui.tasks.create({ input: 'weekly', when: { every: 7 * 24 * hour, times: 2 } });
    expect(task).toMatchObject({ status: 'todo', scheduleId: expect.any(String), notBefore: expect.any(Date) });
    const [schedule] = await ui.schedules.list();
    expect(schedule).toMatchObject({ everyMs: 7 * 24 * hour, remaining: 1, occurrenceTaskId: task.id });
    const cron = await ui.tasks.create({
      input: 'mornings',
      when: { cron: '0 9 * * 1-5', timezone: 'Europe/Berlin', at: new Date(Date.now() + hour) },
    });
    expect(cron.scheduleId).not.toBeNull();
    await expect(ui.tasks.create({ input: 'x', when: { cron: 'nope', timezone: 'UTC' } })).rejects.toThrow(/cron/);
    await expect(ui.tasks.create({ input: 'x', when: { every: 1000 } })).rejects.toThrow();
    await expect(ui.tasks.create({ input: 'x', when: { every: 7e15 } })).rejects.toThrow();
    await expect(ui.tasks.create({ input: 'x', when: { every: hour, times: 3_000_000_000 } })).rejects.toThrow();
    await expect(
      ui.tasks.create({ input: 'x', when: { every: hour, times: 2, until: new Date(Date.now() + 5 * hour) } }),
    ).rejects.toThrow(/not both/);
  });

  it('schedules.setPaused and schedules.remove work the schedule from the page', async () => {
    const ui = plainUi(db);
    const task = await ui.tasks.create({ input: 'weekly', when: { every: hour } });
    const [schedule] = await ui.schedules.list();
    expect(await ui.schedules.setPaused({ id: schedule!.id, paused: true })).toMatchObject({ paused: true });
    await ui.schedules.remove({ id: schedule!.id });
    expect(await ui.schedules.list()).toEqual([]);
    await expect(ui.tasks.get({ id: task.id })).rejects.toThrow();
  });
});

describe('waiting', () => {
  let sessions = 100;
  async function running(title = 't') {
    const task = await plainUi(db).tasks.create({ title, input: 'do it' });
    await ctx.call('laptop', 'claim-task', { id: task.id, machine: 'laptop' });
    await ctx.call('laptop', 'update-task', { id: task.id, body: { sessionId: sessionNamed((sessions += 1)) } });
    return task.id;
  }
  const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

  it('a running task waits with the agent’s comment, frees Running, sorts the latest on top, and is never claimed', async () => {
    const ui = plainUi(db);
    const first = await running('first');
    const second = await running('second');
    const waited = await ctx.call('laptop', 'wait', {
      id: first,
      body: { text: 'Waiting for CI on #1.', wakeAt: inMinutes(5), check: true },
    });
    expect(waited.json.result).toMatchObject({ status: 'waiting', waitCheck: true, next: 'resume', machine: 'laptop' });
    expect(waited.json.result.runStartedAt).toBeNull();
    await ctx.call('laptop', 'wait', { id: second, body: { text: 'A timer.', wakeAt: inMinutes(60) } });
    const list = await ui.tasks.list();
    expect(list.filter((t) => t.status === 'waiting').map((t) => [t.title, t.waitCheck])).toEqual([
      ['second', false],
      ['first', true],
    ]);
    expect((await ctx.call('laptop', 'claim-task', { id: second, machine: 'laptop' })).status).toBe(409);
    const { thread } = await ui.tasks.get({ id: first });
    expect(thread.at(-1)).toMatchObject({ author: 'agent', kind: 'comment', text: 'Waiting for CI on #1.' });
  });

  it('only a running task waits, and only until a time in the next 7 days', async () => {
    const id = await running();
    const bad = (wakeAt: string) => ctx.call('laptop', 'wait', { id, body: { text: 'x', wakeAt } });
    expect((await bad(inMinutes(-1))).status).toBe(400);
    expect((await bad(inMinutes(8 * 24 * 60))).status).toBe(400);
    await ctx.call('laptop', 'wait', { id, body: { text: 'x', wakeAt: inMinutes(5) } });
    expect((await bad(inMinutes(10))).status).toBe(409);
  });

  it('nothing else moves a task into Waiting', async () => {
    const ui = plainUi(db);
    const id = await running();
    expect((await ctx.call('laptop', 'update-task', { id, body: { status: 'waiting' } })).status).toBe(400);
    await ctx.call('laptop', 'update-task', { id, body: { status: 'needs-me' } });
    await expect(ui.tasks.move({ id, status: 'waiting' })).rejects.toThrow(/board wait/);
    expect((await ctx.call('laptop', 'add-task', { body: { title: 't', input: 'x', status: 'waiting' } })).status).toBe(
      400,
    );
  });

  it('a new task cannot start in Running or Done', async () => {
    for (const status of ['running', 'done']) {
      const { status: code } = await ctx.call('laptop', 'add-task', { body: { title: 't', input: 'x', status } });
      expect(code).toBe(400);
    }
  });

  it('a wake puts the task on top of Todo as a resume on its machine, and the worker sees `woken` until its first update', async () => {
    const ui = plainUi(db);
    const id = await running('woken');
    await ui.tasks.create({ title: 'urgent', input: 'do it', priority: 'urgent' });
    await ctx.call('laptop', 'wait', { id, body: { text: 'CI', wakeAt: inMinutes(30), check: true } });
    const woken = await ctx.call('laptop', 'wake', { id, body: 'agent-board: wait over: its check passed.' });
    expect(woken.json.result).toMatchObject({ applied: true, task: { status: 'todo', next: 'resume', woken: true } });
    expect(woken.json.result.task).toMatchObject({ wakeAt: null, waitCheck: false });
    expect((await ui.tasks.list()).filter((t) => t.status === 'todo').map((t) => t.title)).toEqual(['woken', 'urgent']);
    // A second wake (the timer and the check at once) changes nothing.
    expect((await ctx.call('laptop', 'wake', { id, body: 'again' })).json.result).toMatchObject({ applied: false });
    expect((await ctx.call('workstation', 'claim-task', { id, machine: 'workstation' })).status).toBe(409);
    const claimed = await ctx.call('laptop', 'claim-task', { id, machine: 'laptop' });
    expect(claimed.json.result).toMatchObject({ status: 'running', woken: true });
    await ctx.call('laptop', 'update-task', { id, body: { next: 'fresh' } });
    expect((await ctx.call('laptop', 'get-task', { id })).json.result.woken).toBe(false);
    const { thread } = await ui.tasks.get({ id });
    expect(thread.some((n) => n.author === 'system' && n.text.includes('its check passed'))).toBe(true);
  });

  it('Wake now and a drag into Todo end the wait as the user; a drag elsewhere drops it', async () => {
    const ui = plainUi(db);
    const now = await running();
    await ctx.call('laptop', 'wait', { id: now, body: { text: 'x', wakeAt: inMinutes(30) } });
    const woken = await ui.tasks.wakeNow({ id: now });
    expect(woken).toMatchObject({ status: 'todo', next: 'resume', woken: true, wakeAt: null });
    const { thread } = await ui.tasks.get({ id: now });
    expect(thread.at(-1)).toMatchObject({ author: 'server', text: 'Wait ended by you.' });
    await expect(ui.tasks.wakeNow({ id: now })).rejects.toThrow(/not waiting/);

    const dragged = await running();
    await ctx.call('laptop', 'wait', { id: dragged, body: { text: 'x', wakeAt: inMinutes(30) } });
    expect(await ui.tasks.move({ id: dragged, status: 'todo' })).toMatchObject({ next: 'resume', woken: true });

    const parked = await running();
    await ctx.call('laptop', 'wait', { id: parked, body: { text: 'x', wakeAt: inMinutes(30), check: true } });
    expect(await ui.tasks.move({ id: parked, status: 'backlog' })).toMatchObject({
      status: 'backlog',
      woken: false,
      wakeAt: null,
      waitCheck: false,
    });
    expect((await ctx.call('laptop', 'wake', { id: parked, body: 'late' })).json.result).toMatchObject({
      applied: false,
    });
  });
});

describe('a run taken back and claimed by another machine', () => {
  /** The laptop's run, taken back after it went quiet and run again fresh, now runs on the workstation. */
  async function movedToWorkstation() {
    const ui = plainUi(db);
    const task = await ui.tasks.create({ title: 't', input: 'do it' });
    await ctx.call('laptop', 'claim-task', { id: task.id, machine: 'laptop' });
    await admin
      .update(tasks)
      .set({ lastActiveAt: new Date(Date.now() - TAKE_BACK_AFTER_MS - 60_000) })
      .where(eq(tasks.id, task.id));
    await ui.tasks.takeBack({ id: task.id });
    await ui.tasks.move({ id: task.id, status: 'todo' });
    expect((await ctx.call('workstation', 'claim-task', { id: task.id, machine: 'workstation' })).status).toBe(200);
    return task.id;
  }
  const get = async (id: string) => (await ctx.call('workstation', 'get-task', { id })).json.result;

  it('ignores the old machine’s heartbeats, and keeps the new machine’s', async () => {
    const id = await movedToWorkstation();
    await ctx.call('workstation', 'heartbeat', { id, body: { lane: 'reviews', borrowed: false } });
    const before = await get(id);
    await ctx.call('laptop', 'heartbeat', { id, body: { lane: 'implement', borrowed: true } });
    expect(await get(id)).toMatchObject({ lane: 'reviews', borrowed: false, lastActiveAt: before.lastActiveAt });
  });

  it('refuses a pause, wait or fail from the old machine as if the task had stopped running', async () => {
    const id = await movedToWorkstation();
    const wakeAt = new Date(Date.now() + 30 * 60_000).toISOString();
    expect(await ctx.call('laptop', 'pause', { id, body: 'Paused on laptop.' })).toMatchObject({
      status: 409,
      json: { error: 'the task is running on workstation, not on laptop' },
    });
    expect((await ctx.call('laptop', 'wait', { id, body: { text: 'CI', wakeAt } })).status).toBe(409);
    expect(
      (await ctx.call('laptop', 'fail', { id, body: 'The worker exited with code 1.' })).json.result,
    ).toMatchObject({
      applied: false,
      task: { status: 'running', machine: 'workstation' },
    });
    const { thread } = await plainUi(db).tasks.get({ id });
    expect(thread.some((n) => ['Paused on laptop.', 'CI', 'The worker exited with code 1.'].includes(n.text))).toBe(
      false,
    );
    expect((await ctx.call('workstation', 'fail', { id, body: 'x' })).json.result.applied).toBe(true);
  });

  it('refuses a question from the old machine, and takes the new machine’s', async () => {
    const id = await movedToWorkstation();
    expect(await ctx.call('laptop', 'ask', { id, body: { questions: [question] } })).toMatchObject({
      status: 409,
      json: { error: 'the task is running on workstation, not on laptop' },
    });
    const before = await plainUi(db).tasks.get({ id });
    expect(before.task).toMatchObject({ status: 'running', machine: 'workstation', openQuestion: false });
    expect(before.thread.filter((n) => n.kind === 'question')).toEqual([]);
    expect((await ctx.call('workstation', 'ask', { id, body: { questions: [question] } })).status).toBe(200);
    expect(await get(id)).toMatchObject({ status: 'needs-me', openQuestion: true });
  });

  it('lets only the machine the task waits on end the wait', async () => {
    const id = await movedToWorkstation();
    const wakeAt = new Date(Date.now() + 30 * 60_000).toISOString();
    await ctx.call('workstation', 'wait', { id, body: { text: 'CI', wakeAt, check: true } });
    expect((await ctx.call('laptop', 'wake', { id, body: 'check passed' })).json.result).toMatchObject({
      applied: false,
      task: { status: 'waiting' },
    });
    expect((await ctx.call('workstation', 'wake', { id, body: 'check passed' })).json.result).toMatchObject({
      applied: true,
      task: { status: 'todo', machine: 'workstation' },
    });
  });
});

describe('a run taken back and claimed again by the same machine', () => {
  /** The laptop's first run, taken back after it went quiet, and the laptop's second run of the task. */
  async function claimedAgain() {
    const ui = plainUi(db);
    const task = await ui.tasks.create({ title: 't', input: 'do it' });
    const first = (await ctx.call('laptop', 'claim-task', { id: task.id, machine: 'laptop' })).json.result
      .run as string;
    await admin
      .update(tasks)
      .set({ lastActiveAt: new Date(Date.now() - TAKE_BACK_AFTER_MS - 60_000) })
      .where(eq(tasks.id, task.id));
    await ui.tasks.takeBack({ id: task.id });
    await ui.tasks.move({ id: task.id, status: 'todo' });
    const second = (await ctx.call('laptop', 'claim-task', { id: task.id, machine: 'laptop' })).json.result
      .run as string;
    return { id: task.id, first, second };
  }
  const get = async (id: string) => (await ctx.call('laptop', 'get-task', { id })).json.result;
  const wakeAt = () => new Date(Date.now() + 30 * 60_000).toISOString();
  const later = 'the task is running in a later run, not in this one';

  it('gives each claim its own run id, which the task shows only while it runs', async () => {
    const { id, first, second } = await claimedAgain();
    expect(first).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(second).not.toBe(first);
    expect((await get(id)).run).toBe(second);
    await ctx.call('laptop', 'update-task', { id, run: second, body: { status: 'needs-me' } });
    expect((await get(id)).run).toBeUndefined();
  });

  it('ignores the old run’s heartbeats, and keeps the new run’s', async () => {
    const { id, first, second } = await claimedAgain();
    await ctx.call('laptop', 'heartbeat', { id, run: second, body: { lane: 'reviews', borrowed: false } });
    const before = await get(id);
    await ctx.call('laptop', 'heartbeat', { id, run: first, body: { lane: 'implement', borrowed: true } });
    expect(await get(id)).toMatchObject({ lane: 'reviews', borrowed: false, lastActiveAt: before.lastActiveAt });
  });

  it('refuses a pause, wait, fail, question or stop from the old run as if the task had stopped running', async () => {
    const { id, first, second } = await claimedAgain();
    expect(await ctx.call('laptop', 'pause', { id, run: first, body: 'Paused on laptop.' })).toMatchObject({
      status: 409,
      json: { error: later },
    });
    expect(
      await ctx.call('laptop', 'wait', { id, run: first, body: { text: 'CI', wakeAt: wakeAt(), check: false } }),
    ).toMatchObject({ status: 409, json: { error: later } });
    expect(await ctx.call('laptop', 'ask', { id, run: first, body: { questions: [question] } })).toMatchObject({
      status: 409,
      json: { error: later },
    });
    expect(await ctx.call('laptop', 'stopped', { id, run: first, body: 'Stopped by you.' })).toMatchObject({
      status: 409,
      json: { error: later },
    });
    expect((await ctx.call('laptop', 'fail', { id, run: first, body: 'exit 1' })).json.result).toMatchObject({
      applied: false,
      task: { status: 'running', run: second },
    });
    const { task, thread } = await plainUi(db).tasks.get({ id });
    expect(task).toMatchObject({ status: 'running', openQuestion: false });
    expect(thread.some((n) => ['Paused on laptop.', 'CI', 'Stopped by you.', 'exit 1'].includes(n.text))).toBe(false);
    expect((await ctx.call('laptop', 'fail', { id, run: second, body: 'exit 1' })).json.result.applied).toBe(true);
  });

  it('keeps the new run’s inbox from the old run', async () => {
    const { id, first, second } = await claimedAgain();
    await plainUi(db).tasks.send({ id, message: 'hello' });
    expect(await ctx.call('laptop', 'run-inbox', { id, run: first })).toMatchObject({
      status: 409,
      json: { error: later },
    });
    expect((await ctx.call('laptop', 'ack-messages', { id, run: first, body: { ids: [], stop: true } })).status).toBe(
      409,
    );
    const inbox = await ctx.call('laptop', 'run-inbox', { id, run: second });
    expect(inbox.json.result.messages).toMatchObject([{ text: 'hello', pending: true }]);
  });

  it('refuses any change from the old run, and a move from the new run only once it no longer holds the task', async () => {
    const { id, first, second } = await claimedAgain();
    expect(await ctx.call('laptop', 'update-task', { id, run: first, body: { status: 'done' } })).toMatchObject({
      status: 409,
      json: { error: later },
    });
    expect((await ctx.call('laptop', 'update-task', { id, run: first, body: { sessionId: SESSION } })).status).toBe(
      409,
    );
    expect(await get(id)).toMatchObject({ status: 'running', run: second, sessionId: null });

    expect((await ctx.call('laptop', 'update-task', { id, run: second, body: { sessionId: SESSION } })).status).toBe(
      200,
    );
    await ctx.call('laptop', 'ask', { id, run: second, body: { questions: [question] } });
    // The run's own bookkeeping after the agent reported still goes through; a move does not.
    expect((await ctx.call('laptop', 'update-task', { id, run: second, body: { next: 'fresh' } })).status).toBe(200);
    expect(await ctx.call('laptop', 'update-task', { id, run: second, body: { status: 'done' } })).toMatchObject({
      status: 409,
      json: { error: 'the task is needs-me, no longer running in this run' },
    });
    expect(await get(id)).toMatchObject({ status: 'needs-me', openQuestion: true });
  });

  it('acts as before for a call that names no run', async () => {
    const { id } = await claimedAgain();
    expect((await ctx.call('laptop', 'pause', { id, body: 'Paused on laptop.' })).status).toBe(200);
    expect((await ctx.call('laptop', 'update-task', { id, body: { status: 'done' } })).status).toBe(200);
  });

  it('refuses a run that is not a run id', async () => {
    const { id } = await claimedAgain();
    expect(await ctx.call('laptop', 'heartbeat', { id, run: 'x', body: { lane: 'a', borrowed: false } })).toMatchObject(
      { status: 400, json: { error: 'run must be a run id' } },
    );
  });
});

describe('a run on another machine, named by its run id', () => {
  it('still answers the old machine with the machine it runs on, and takes the new machine’s run', async () => {
    const ui = plainUi(db);
    const task = await ui.tasks.create({ title: 't', input: 'do it' });
    const id = task.id;
    const first = (await ctx.call('laptop', 'claim-task', { id, machine: 'laptop' })).json.result.run as string;
    await admin
      .update(tasks)
      .set({ lastActiveAt: new Date(Date.now() - TAKE_BACK_AFTER_MS - 60_000) })
      .where(eq(tasks.id, id));
    await ui.tasks.takeBack({ id });
    await ui.tasks.move({ id, status: 'todo' });
    const second = (await ctx.call('workstation', 'claim-task', { id, machine: 'workstation' })).json.result
      .run as string;
    expect(await ctx.call('laptop', 'pause', { id, run: first, body: 'x' })).toMatchObject({
      status: 409,
      json: { error: 'the task is running on workstation, not on laptop' },
    });
    // The machine is checked before the run: a run id alone does not let another machine in.
    expect((await ctx.call('laptop', 'run-inbox', { id, run: second })).status).toBe(403);
    expect((await ctx.call('laptop', 'fail', { id, run: second, body: 'x' })).json.result.applied).toBe(false);
    expect((await ctx.call('workstation', 'ask', { id, run: second, body: { questions: [question] } })).status).toBe(
      200,
    );
  });
});

describe('messages and stop requests for a running task', () => {
  /** A run whose worker has looked at its inbox, as every worker of CLI 0.9 does once its process started. */
  async function running(withSession = true, readsInbox = true) {
    const task = await plainUi(db).tasks.create({ title: 't', input: 'do it' });
    await ctx.call('laptop', 'claim-task', { id: task.id, machine: 'laptop' });
    if (withSession) await ctx.call('laptop', 'update-task', { id: task.id, body: { sessionId: SESSION } });
    if (readsInbox) await ctx.call('laptop', 'run-inbox', { id: task.id });
    return task.id;
  }
  const inbox = async (id: string, machine: 'laptop' | 'workstation' = 'laptop') =>
    (await ctx.call(machine, 'run-inbox', { id })).json.result as {
      stop: boolean;
      stopMessage?: string;
      messages: { id: string; text: string; pending?: boolean; queued?: boolean }[];
    };

  it('Send on a running task waits as a pending note; the worker reads, hands it over and acknowledges it', async () => {
    const ui = plainUi(db);
    const id = await running();
    expect(await ui.tasks.send({ id, message: 'also check the migration' })).toMatchObject({ status: 'running' });
    const { messages, stop } = await inbox(id);
    expect(stop).toBe(false);
    expect(messages).toMatchObject([{ text: 'also check the migration', author: 'user', pending: true }]);
    expect((await ui.tasks.get({ id })).thread.at(-1)).toMatchObject({
      text: 'also check the migration',
      pending: true,
    });

    expect((await ctx.call('laptop', 'ack-messages', { id, body: { ids: [messages[0]!.id] } })).status).toBe(200);
    expect((await inbox(id)).messages).toEqual([]);
    const note = (await ui.tasks.get({ id })).thread.at(-1);
    expect(note?.pending).toBeUndefined();
    expect(note?.deliveredAt).toBeTruthy();
    expect((await ctx.call('laptop', 'get-task', { id })).json.result.status).toBe('running');
  });

  it('only the machine that runs the task reads or acknowledges its inbox, and only while it runs', async () => {
    const ui = plainUi(db);
    const id = await running();
    await ui.tasks.send({ id, message: 'hello' });
    expect(await ctx.call('workstation', 'run-inbox', { id })).toMatchObject({
      status: 403,
      json: { error: expect.stringMatching(/runs on laptop, not on workstation/) },
    });
    expect((await ctx.call('workstation', 'ack-messages', { id, body: { ids: [] } })).status).toBe(403);
    expect((await ctx.call('workstation', 'stopped', { id, body: 'x' })).status).toBe(403);
    expect((await ctx.call('laptop', 'ack-messages', { id, body: { ids: ['not an id!'] } })).status).toBe(400);
    await ctx.call('laptop', 'update-task', { id, body: { status: 'needs-me' } });
    expect((await ctx.call('laptop', 'run-inbox', { id })).status).toBe(409);
    expect((await ctx.call('laptop', 'ack-messages', { id, body: { ids: [] } })).status).toBe(409);
    expect((await ctx.call('laptop', 'run-inbox', { id: 'nope' })).status).toBe(404);
  });

  it('Send on a task that is not running is Send & continue', async () => {
    const ui = plainUi(db);
    const id = await running();
    await ctx.call('laptop', 'update-task', { id, body: { status: 'needs-me' } });
    expect(await ui.tasks.send({ id, message: 'go on' })).toMatchObject({ status: 'todo', next: 'resume' });
    expect((await ui.tasks.get({ id })).thread.at(-1)).toMatchObject({ text: 'go on' });
  });

  it('Stop asks a running task to end; the worker acknowledges once, ends the run and the task waits in Needs me', async () => {
    const ui = plainUi(db);
    const id = await running();
    expect(await ui.tasks.stop({ id })).toMatchObject({ status: 'running', stopRequested: true });
    expect(await inbox(id)).toMatchObject({ stop: true, messages: [] });
    await ctx.call('laptop', 'ack-messages', { id, body: { ids: [], stop: true } });
    expect(await inbox(id)).toMatchObject({ stop: false });
    expect((await ctx.call('laptop', 'get-task', { id })).json.result.stopRequested).toBe(false);

    await ui.tasks.stop({ id });
    const stopped = await ctx.call('laptop', 'stopped', { id, body: 'Stopped by you.' });
    expect(stopped.json.result).toMatchObject({ status: 'needs-me', stopRequested: false });
    expect((await ui.tasks.get({ id })).thread.at(-1)).toMatchObject({ author: 'system', text: 'Stopped by you.' });
    expect((await ctx.call('laptop', 'stopped', { id, body: 'again' })).status).toBe(409);
  });

  it('Stop & send keeps the message pending behind the stop request, for the worker to hand over after the interrupt', async () => {
    const ui = plainUi(db);
    const id = await running();
    await ui.tasks.stop({ id, message: 'use the other table' });
    const { stop, stopMessage, messages } = await inbox(id);
    expect(stop).toBe(true);
    expect(messages).toMatchObject([{ text: 'use the other table', pending: true, queued: true }]);
    expect(stopMessage).toBe(messages[0]!.id);
    await ctx.call('laptop', 'ack-messages', { id, body: { ids: [messages[0]!.id], stop: true } });
    expect(await inbox(id)).toEqual({ stop: false, messages: [] });
    expect((await ctx.call('laptop', 'get-task', { id })).json.result.status).toBe('running');
  });

  it('a plain Stop names no message, even with earlier ones pending; a user stop ends in Needs me and turns them into replies', async () => {
    const ui = plainUi(db);
    const id = await running();
    await ui.tasks.send({ id, message: 'earlier thought' });
    await ui.tasks.stop({ id });
    const { stop, stopMessage, messages } = await inbox(id);
    expect([stop, stopMessage, messages.length]).toEqual([true, undefined, 1]);
    await ctx.call('laptop', 'ack-messages', { id, body: { ids: [], stop: true } });
    const stopped = await ctx.call('laptop', 'stopped', { id, body: 'Stopped by you.' });
    expect(stopped.json.result).toMatchObject({ status: 'needs-me', stopRequested: false });
    const note = (await ui.tasks.get({ id })).thread.find((n) => n.text === 'earlier thought');
    expect(note?.pending).toBeUndefined();
    expect(note).toMatchObject({ queued: true });
    // The next Send & continue carries it: it is a reply, not a pending message.
    expect(await ui.tasks.send({ id, message: 'go on' })).toMatchObject({ status: 'todo', next: 'resume' });
  });

  it('Stop takes an answered task that was not picked up to Needs me, a wait to Backlog, and refuses the rest', async () => {
    const ui = plainUi(db);
    const answered = await running();
    await ctx.call('laptop', 'update-task', { id: answered, body: { status: 'needs-me' } });
    await ui.tasks.reply({ id: answered, message: 'go on', resume: true });
    expect(await ui.tasks.stop({ id: answered })).toMatchObject({ status: 'needs-me' });

    const waiting = await running();
    await ctx.call('laptop', 'wait', {
      id: waiting,
      body: { text: 'CI', wakeAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
    expect(await ui.tasks.stop({ id: waiting })).toMatchObject({ status: 'backlog', wakeAt: null });

    const fresh = await ui.tasks.create({ title: 'new', input: 'x' });
    await expect(ui.tasks.stop({ id: fresh.id })).rejects.toThrow(/only a running, waiting or answered task/);
    const parked = await ui.tasks.create({ title: 'parked', input: 'x', when: 'backlog' });
    await expect(ui.tasks.stop({ id: parked.id })).rejects.toThrow(/backlog/);
  });

  describe('a message nobody handed over is never lost when the run ends', () => {
    const endings: [string, (id: string) => Promise<unknown>][] = [
      [
        'the agent reports and moves to Needs me',
        (id) => ctx.call('laptop', 'update-task', { id, body: { status: 'needs-me' } }),
      ],
      ['the agent marks it done', (id) => ctx.call('laptop', 'update-task', { id, body: { status: 'done' } })],
      ['the agent asks a question', (id) => ctx.call('laptop', 'ask', { id, body: { questions: [question] } })],
      [
        'the agent waits',
        (id) =>
          ctx.call('laptop', 'wait', {
            id,
            body: { text: 'CI', wakeAt: new Date(Date.now() + 3_600_000).toISOString() },
          }),
      ],
      ['the worker fails', (id) => ctx.call('laptop', 'fail', { id, body: 'crashed' })],
    ];
    it.each(endings)('%s: the task resumes with it on top of Todo', async (_name, end) => {
      const ui = plainUi(db);
      const other = await ui.tasks.create({ title: 'other', input: 'x', priority: 'urgent' });
      const id = await running();
      await ui.tasks.send({ id, message: 'one more thing' });
      await end(id);
      const task = (await ctx.call('laptop', 'get-task', { id })).json.result;
      expect(task).toMatchObject({
        status: 'todo',
        next: 'resume',
        openQuestion: false,
        wakeAt: null,
        stopRequested: false,
      });
      expect((await ui.tasks.list()).filter((t) => t.status === 'todo').map((t) => t.id)).toEqual([id, other.id]);
      const note = (await ui.tasks.get({ id })).thread.find((n) => n.text === 'one more thing');
      // A reply now: the next resume prompt carries it, and the run inbox does not hand it over again.
      expect(note).toMatchObject({ author: 'user', kind: 'comment', queued: true });
      expect(note?.pending).toBeUndefined();
      expect((await ui.tasks.get({ id })).thread.some((n) => n.text.startsWith('Your message reached the agent'))).toBe(
        true,
      );
      expect(note?.deliveredAt).toBeUndefined();
      await ctx.call('laptop', 'claim-task', { id, machine: 'laptop' });
      expect((await inbox(id)).messages).toEqual([]);
    });

    it('a task without a session starts fresh', async () => {
      const ui = plainUi(db);
      const id = await running(false);
      await ui.tasks.send({ id, message: 'one more thing' });
      await ctx.call('laptop', 'update-task', { id, body: { status: 'needs-me' } });
      expect((await ctx.call('laptop', 'get-task', { id })).json.result).toMatchObject({
        status: 'todo',
        next: 'fresh',
      });
    });

    it('taking the task back is the user ending it: Needs me, and the message becomes a reply', async () => {
      const ui = plainUi(db);
      const id = await running();
      await ui.tasks.send({ id, message: 'one more thing' });
      await admin
        .update(tasks)
        .set({ lastActiveAt: new Date(Date.now() - TAKE_BACK_AFTER_MS - 1_000) })
        .where(eq(tasks.id, id));
      expect(await ui.tasks.takeBack({ id })).toMatchObject({ status: 'needs-me' });
      const note = (await ui.tasks.get({ id })).thread.find((n) => n.text === 'one more thing');
      expect(note?.pending).toBeUndefined();
      expect(note?.queued).toBe(true);
    });

    it('a run whose worker never read the inbox (a CLI before 0.9) is not redirected: the message becomes a plain reply', async () => {
      const ui = plainUi(db);
      const id = await running(true, false);
      await ui.tasks.send({ id, message: 'one more thing' });
      await ctx.call('laptop', 'update-task', { id, body: { status: 'needs-me' } });
      expect((await ctx.call('laptop', 'get-task', { id })).json.result.status).toBe('needs-me');
      const { thread } = await ui.tasks.get({ id });
      expect(thread.find((n) => n.text === 'one more thing')?.pending).toBeUndefined();
      expect(thread.some((n) => n.text.startsWith('Your message reached the agent'))).toBe(false);
    });

    it('reading the inbox is remembered for the run only', async () => {
      const ui = plainUi(db);
      const id = await running();
      await ctx.call('laptop', 'update-task', { id, body: { status: 'needs-me' } });
      await ui.tasks.send({ id, message: 'go on' });
      await ctx.call('laptop', 'claim-task', { id, machine: 'laptop' });
      await ui.tasks.send({ id, message: 'late' });
      await ctx.call('laptop', 'update-task', { id, body: { status: 'needs-me' } });
      expect((await ctx.call('laptop', 'get-task', { id })).json.result.status).toBe('needs-me');
    });

    it('a pause joins the resume with it, and is still a pause', async () => {
      const ui = plainUi(db);
      const id = await running();
      await ui.tasks.send({ id, message: 'one more thing' });
      expect((await ctx.call('laptop', 'pause', { id, body: 'Paused on laptop' })).json.result).toMatchObject({
        status: 'todo',
        paused: true,
      });
      expect((await ui.tasks.get({ id })).thread.find((n) => n.text === 'one more thing')?.pending).toBeUndefined();
    });

    it('messages that were handed over do not bring the task back', async () => {
      const ui = plainUi(db);
      const id = await running();
      await ui.tasks.send({ id, message: 'handed' });
      const [message] = (await inbox(id)).messages;
      await ctx.call('laptop', 'ack-messages', { id, body: { ids: [message!.id] } });
      await ctx.call('laptop', 'update-task', { id, body: { status: 'needs-me' } });
      expect((await ctx.call('laptop', 'get-task', { id })).json.result.status).toBe('needs-me');
    });
  });
});
