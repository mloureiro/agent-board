import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from './client';
import { isPgliteUrl, parsePgliteUrl, parseSharedBuffers } from './pglite';

describe('parsePgliteUrl', () => {
  it('takes the data directory from the path and no role from a bare URL', () => {
    expect(parsePgliteUrl('pglite://local/var/lib/board')).toEqual({ dataDir: '/var/lib/board', role: '' });
  });

  it('decodes a path that holds a space', () => {
    expect(parsePgliteUrl('pglite://local/Users/x/Library/Application%20Support/board/db')).toEqual({
      dataDir: '/Users/x/Library/Application Support/board/db',
      role: '',
    });
  });

  it.each([
    ['without a password', 'pglite://board_app@local/data'],
    ['with a password, which is ignored', 'pglite://board_app:secret@local/data'],
  ])('reads the role %s', (_name, url) => {
    expect(parsePgliteUrl(url)).toEqual({ dataDir: '/data', role: 'board_app' });
  });

  it.each([
    ['a missing host token', 'pglite:///data'],
    ['another host', 'pglite://elsewhere/data'],
    ['no path', 'pglite://local'],
    ['the filesystem root', 'pglite://local/'],
    ['a relative path with no authority', 'pglite:local/data'],
    ['a role that is not a plain identifier', 'pglite://Board%20App@local/data'],
  ])('refuses %s', (_name, url) => {
    expect(() => parsePgliteUrl(url)).toThrow();
  });
});

describe('isPgliteUrl', () => {
  it('tells the two URL kinds apart', () => {
    expect(isPgliteUrl('pglite://local/data')).toBe(true);
    expect(isPgliteUrl('postgresql://board@localhost/board')).toBe(false);
  });
});

describe('parseSharedBuffers', () => {
  it.each([
    [undefined, null],
    ['', null],
    ['  ', null],
    ['8MB', '8MB'],
    [' 128kB ', '128kB'],
    ['1GB', '1GB'],
  ])('reads %j as %j', (value, expected) => {
    expect(parseSharedBuffers(value)).toBe(expected);
  });

  it.each(['8', 'MB', '8mb', '8 MB', '8MiB', '-8MB', '1.5GB'])('refuses %j', (value) => {
    expect(() => parseSharedBuffers(value)).toThrow('PGLITE_SHARED_BUFFERS');
  });
});

describe('a PGlite setting next to a Postgres URL', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is a start error rather than a setting that does nothing', async () => {
    vi.stubEnv('PGLITE_SHARED_BUFFERS', '8MB');
    await expect(createDb('postgresql://board:board@localhost:1/board')).rejects.toThrow('pglite:// database URL');
  });

  it('does not stop a Postgres URL when the setting is empty', async () => {
    vi.stubEnv('PGLITE_SHARED_BUFFERS', '');
    const { pool } = await createDb('postgresql://board:board@localhost:1/board');
    await pool.end();
  });
});
