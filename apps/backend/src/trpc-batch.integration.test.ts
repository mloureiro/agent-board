import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from './server';
import { testConfig, useTestDb } from './test/helpers';

const { db } = useTestDb();

const open: { close(): Promise<unknown> }[] = [];
afterEach(() => Promise.all(open.splice(0).map((app) => app.close())));

describe('a batch of tRPC calls', () => {
  it('is answered however many procedures its path names', async () => {
    const app = await buildServer(testConfig, db);
    open.push(app);
    const procedures = Array.from({ length: 40 }, () => 'revision');
    const answer = await app.inject({ method: 'GET', url: `/trpc/${procedures.join(',')}?batch=1&input=%7B%7D` });
    expect(answer.statusCode).toBe(200);
    expect(JSON.parse(answer.body)).toHaveLength(40);
  });
});
