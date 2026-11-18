import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const base = { DATABASE_URL: 'postgresql://x/y', APP_DATABASE_URL: 'postgresql://x/y' };
const load = (env: Record<string, string>) => loadConfig({ ...base, ...env });
const login = { PUBLIC_URL: 'https://board.example.com' };

describe('login off', () => {
  it('is NO_LOGIN_USER, lower-cased and allowed in production', () => {
    expect(load({ NODE_ENV: 'production', NO_LOGIN_USER: ' Jascha ' }).auth).toEqual({ login: false, user: 'jascha' });
  });

  it('reads DEV_AUTH_USER as the same setting outside production, and refuses it in production', () => {
    expect(load({ DEV_AUTH_USER: 'dev' }).auth).toEqual({ login: false, user: 'dev' });
    expect(load({ DEV_AUTH_USER: 'dev', NO_LOGIN_USER: 'ops' }).auth).toEqual({ login: false, user: 'ops' });
    expect(() => load({ NODE_ENV: 'production', DEV_AUTH_USER: 'dev' })).toThrow('use NO_LOGIN_USER');
    expect(() => load({ NODE_ENV: 'production', DEV_AUTH_USER: 'dev', NO_LOGIN_USER: 'ops' })).toThrow(
      'use NO_LOGIN_USER',
    );
  });

  it('refuses a name that is no user name', () => {
    expect(() => load({ NO_LOGIN_USER: 'two words' })).toThrow('NO_LOGIN_USER must be a name');
  });

  it.each([
    ['OIDC_ISSUER', 'https://idp.example.com'],
    ['OIDC_LABEL', 'Corp'],
    ['SAML_ENTRY_POINT', 'https://idp.example.com/sso'],
    ['SIGNUP_TOKEN', 'a'.repeat(32)],
    ['PUBLIC_URL', 'https://board.example.com'],
    ['PASSKEYS', 'off'],
    ['SESSION_DAYS', '7'],
    ['ALLOWED_GROUPS', 'admins'],
  ])('cannot be combined with %s', (name, value) => {
    expect(() => load({ NO_LOGIN_USER: 'dev', [name]: value })).toThrow(`${name} would do nothing`);
    expect(() => load({ DEV_AUTH_USER: 'dev', [name]: value })).toThrow(`${name} would do nothing`);
  });
});

describe('login on', () => {
  it('names both ways out when neither is set', () => {
    expect(() => load({})).toThrow(/PUBLIC_URL.*NO_LOGIN_USER/);
  });

  it('takes the passkey defaults from PUBLIC_URL', () => {
    expect(load(login).auth).toEqual({
      login: true,
      publicUrl: 'https://board.example.com',
      rpId: 'board.example.com',
      sessionDays: 30,
      passkeys: true,
      signupToken: null,
      allowedGroups: [],
      oidc: null,
      saml: null,
    });
  });

  it('wants an origin, over https in production', () => {
    expect(() => load({ PUBLIC_URL: 'https://board.example.com/app' })).toThrow('must be an origin');
    expect(() => load({ PUBLIC_URL: 'https://board.example.com/?x=1' })).toThrow('must be an origin');
    expect(() => load({ PUBLIC_URL: 'board.example.com' })).toThrow('PUBLIC_URL must be a URL');
    expect(() => load({ NODE_ENV: 'production', PUBLIC_URL: 'http://board.example.com' })).toThrow('https');
    expect(load({ PUBLIC_URL: 'http://localhost:5173/' }).auth).toMatchObject({
      publicUrl: 'http://localhost:5173',
      rpId: 'localhost',
    });
  });

  it('takes PASSKEYS on or off and needs some way to sign in', () => {
    expect(() => load({ ...login, PASSKEYS: 'maybe' })).toThrow('PASSKEYS must be');
    expect(() => load({ ...login, PASSKEYS: 'off' })).toThrow('No way to sign in');
    expect(
      load({
        ...login,
        PASSKEYS: 'off',
        OIDC_ISSUER: 'https://i.example.com',
        OIDC_CLIENT_ID: 'a',
        OIDC_CLIENT_SECRET: 'b',
      }).auth,
    ).toMatchObject({ passkeys: false });
  });

  it('checks the sign-up token', () => {
    expect(() => load({ ...login, SIGNUP_TOKEN: 'short' })).toThrow('at least 32 characters');
    expect(() =>
      load({
        ...login,
        SIGNUP_TOKEN: 'a'.repeat(32),
        PASSKEYS: 'off',
        SAML_ENTRY_POINT: 'https://i.example.com/sso',
        SAML_IDP_CERT: 'x',
      }),
    ).toThrow('needs PASSKEYS=on');
    expect(load({ ...login, SIGNUP_TOKEN: ` ${'a'.repeat(32)}\n` }).auth).toMatchObject({
      signupToken: 'a'.repeat(32),
    });
  });

  it('keeps the session length between 1 and 365 days', () => {
    expect(load({ ...login, SESSION_DAYS: '7' }).auth).toMatchObject({ sessionDays: 7 });
    for (const days of ['0', '366', '1.5', 'x'])
      expect(() => load({ ...login, SESSION_DAYS: days })).toThrow('SESSION_DAYS');
  });
});

describe('OIDC', () => {
  const oidc = { OIDC_ISSUER: 'https://idp.example.com', OIDC_CLIENT_ID: 'board', OIDC_CLIENT_SECRET: 's3cret' };

  it('is on with an issuer and defaults for the rest', () => {
    expect(load({ ...login, ...oidc }).auth).toMatchObject({
      oidc: {
        issuer: new URL('https://idp.example.com'),
        clientId: 'board',
        clientSecret: 's3cret',
        scopes: 'openid profile email',
        usernameClaim: 'preferred_username',
        groupsClaim: 'groups',
        label: 'Single sign-on',
      },
    });
  });

  it('needs all of issuer, client id and secret', () => {
    expect(() => load({ ...login, OIDC_ISSUER: oidc.OIDC_ISSUER })).toThrow(
      'needs OIDC_CLIENT_ID and OIDC_CLIENT_SECRET',
    );
    expect(() => load({ ...login, OIDC_CLIENT_ID: 'board' })).toThrow('need OIDC_ISSUER');
  });

  it('wants https in production, openid in the scopes, and a short label', () => {
    expect(() => load({ ...login, ...oidc, NODE_ENV: 'production', OIDC_ISSUER: 'http://idp.example.com' })).toThrow(
      'OIDC_ISSUER must be an https URL',
    );
    expect(() => load({ ...login, ...oidc, OIDC_SCOPES: 'profile' })).toThrow('must include openid');
    const label = load({ ...login, ...oidc, OIDC_LABEL: `Corp\nlogin ${'x'.repeat(100)}` }).auth;
    expect(label.login && label.oidc?.label).toHaveLength(40);
    expect(label.login && label.oidc?.label).not.toContain('\n');
  });

  it('refuses ALLOWED_GROUPS without OIDC, which is the only method that checks it', () => {
    expect(() => load({ ...login, ALLOWED_GROUPS: 'admins' })).toThrow('ALLOWED_GROUPS needs OIDC_ISSUER');
    expect(() =>
      load({ ...login, ALLOWED_GROUPS: 'admins', SAML_ENTRY_POINT: 'https://i.example.com/sso', SAML_IDP_CERT: 'x' }),
    ).toThrow('ALLOWED_GROUPS needs OIDC_ISSUER');
    expect(load({ ...login, ALLOWED_GROUPS: ' , ' }).auth).toMatchObject({ allowedGroups: [] });
  });

  it('reads the allowed groups', () => {
    expect(load({ ...login, ...oidc, ALLOWED_GROUPS: ' admins, family ,' }).auth).toMatchObject({
      allowedGroups: ['admins', 'family'],
    });
  });
});

describe('SAML', () => {
  const saml = { SAML_ENTRY_POINT: 'https://idp.example.com/sso', SAML_IDP_CERT: 'MIIC' };

  it('is on with an entry point and a certificate, the issuer defaulting to PUBLIC_URL', () => {
    expect(load({ ...login, ...saml }).auth).toMatchObject({
      saml: {
        entryPoint: 'https://idp.example.com/sso',
        idpCert: 'MIIC',
        issuer: 'https://board.example.com',
        usernameAttribute: null,
        label: 'SAML sign-on',
      },
    });
  });

  it('needs a certificate, and wants the entry point over https in production', () => {
    expect(() => load({ ...login, SAML_ENTRY_POINT: saml.SAML_ENTRY_POINT })).toThrow('needs SAML_IDP_CERT');
    expect(() => load({ ...login, SAML_IDP_CERT: 'MIIC' })).toThrow('needs SAML_ENTRY_POINT');
    expect(() =>
      load({ ...login, ...saml, NODE_ENV: 'production', SAML_ENTRY_POINT: 'http://idp.example.com' }),
    ).toThrow('https');
    expect(() => load({ ...login, ...saml, SAML_IDP_CERT_FILE: '/nonexistent' })).toThrow('not both');
    expect(() =>
      load({ ...login, SAML_ENTRY_POINT: saml.SAML_ENTRY_POINT, SAML_IDP_CERT_FILE: '/nonexistent' }),
    ).toThrow('cannot be read');
  });
});

describe('GIT_SHA', () => {
  const noLogin = { NO_LOGIN_USER: 'jascha' };
  it('is the commit, lower-cased', () => {
    expect(load({ ...noLogin, GIT_SHA: ` ${'A1'.repeat(20)} ` }).revision).toBe('a1'.repeat(20));
  });

  it.each(['', 'main', 'abc', 'g'.repeat(40), 'a'.repeat(41)])('is unknown for %j', (value) => {
    expect(load({ ...noLogin, GIT_SHA: value }).revision).toBeNull();
  });
});

describe('HOST', () => {
  const noLogin = { NO_LOGIN_USER: 'jascha' };
  it('defaults to all interfaces', () => {
    expect(load(noLogin).host).toBe('0.0.0.0');
  });

  it('uses the given address, trimmed', () => {
    expect(load({ ...noLogin, HOST: ' 127.0.0.1\n' }).host).toBe('127.0.0.1');
  });

  it('falls back when blank', () => {
    expect(load({ ...noLogin, HOST: '   ' }).host).toBe('0.0.0.0');
  });
});
