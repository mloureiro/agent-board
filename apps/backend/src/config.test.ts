import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config';

afterEach(() => vi.unstubAllEnvs());

function stubEnv(env: Record<string, string>): void {
  vi.stubEnv('DATABASE_URL', 'postgresql://x/y');
  vi.stubEnv('APP_DATABASE_URL', 'postgresql://x/y');
  vi.stubEnv('PROXY_SECRET', '');
  vi.stubEnv('INTAKE_TOKEN', '');
  vi.stubEnv('DEV_AUTH_USER', '');
  Object.entries(env).forEach(([name, value]) => vi.stubEnv(name, value));
}

describe('PROXY_SECRET', () => {
  it('is required in production', () => {
    stubEnv({ NODE_ENV: 'production' });
    expect(() => loadConfig()).toThrow('PROXY_SECRET must be set in production');
  });

  it('may be unset outside production', () => {
    stubEnv({ NODE_ENV: 'development' });
    expect(loadConfig().proxySecret).toBeNull();
  });

  it('must be at least 32 characters', () => {
    stubEnv({ NODE_ENV: 'development', PROXY_SECRET: 'short' });
    expect(() => loadConfig()).toThrow('PROXY_SECRET must be at least 32 characters');
  });

  it('is trimmed', () => {
    const secret = 'a'.repeat(32);
    stubEnv({ NODE_ENV: 'production', PROXY_SECRET: ` ${secret}\n` });
    expect(loadConfig().proxySecret).toBe(secret);
  });
});

describe('HOST', () => {
  it('defaults to all interfaces', () => {
    stubEnv({});
    vi.stubEnv('HOST', undefined);
    expect(loadConfig().host).toBe('0.0.0.0');
  });

  it('uses the given address, trimmed', () => {
    stubEnv({ HOST: ' 127.0.0.1\n' });
    expect(loadConfig().host).toBe('127.0.0.1');
  });

  it('falls back when blank', () => {
    stubEnv({ HOST: '   ' });
    expect(loadConfig().host).toBe('0.0.0.0');
  });
});
