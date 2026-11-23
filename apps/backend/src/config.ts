import { isReleaseVersion } from '@agent-board/shared';
import { readFileSync } from 'node:fs';
import { parseUsername } from './services/auth/username';

type Env = NodeJS.ProcessEnv;

const requireEnv = (env: Env, name: string): string => {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};

const optionalEnv = (env: Env, name: string): string | null => env[name]?.trim() || null;

export interface OidcConfig {
  issuer: URL;
  clientId: string;
  clientSecret: string;
  scopes: string;
  usernameClaim: string;
  groupsClaim: string;
  label: string;
}

export interface SamlConfig {
  entryPoint: string;
  /** PEM, or the bare base64 body of the certificate. */
  idpCert: string;
  issuer: string;
  /** The assertion attribute that names the user; null means the NameID. */
  usernameAttribute: string | null;
  label: string;
}

/** The board signs users in itself: passkeys, OIDC and SAML. */
export interface LoginConfig {
  login: true;
  /** The board's origin as the browser sees it, without a trailing slash. */
  publicUrl: string;
  /** The WebAuthn relying party id: the hostname of `publicUrl`. */
  rpId: string;
  sessionDays: number;
  passkeys: boolean;
  /** Lets a new user create an account with a passkey by presenting it; null means sign-up is closed. */
  signupToken: string | null;
  /** OIDC only: groups of which the user needs one; empty means no check. */
  allowedGroups: string[];
  oidc: OidcConfig | null;
  saml: SamlConfig | null;
}

/** Without login every request is `user`. */
export interface NoLoginConfig {
  login: false;
  user: string;
}

export type AuthConfig = LoginConfig | NoLoginConfig;

export interface Config {
  nodeEnv: string;
  port: number;
  /** Owner/admin connection: bootstrap and migrations only. */
  databaseUrl: string;
  /** The unprivileged `board_app` connection that serves every request. */
  appDatabaseUrl: string;
  /** Owner for rows that predate tenancy; read only by the migration that adds owners. */
  backfillOwner: string | null;
  auth: AuthConfig;
  /** Host header values (host or host:port, lower-case) the backend answers; empty means no check. */
  allowedHosts: string[];
  /** The newest CLI release, x.y.z, which the machine API advertises; null when this build does not know it. */
  cliVersion: string | null;
  /** The git commit this build came from, for the settings page; null when the build was not given one. */
  revision: string | null;
}

/** An unset or malformed value is "unknown", not a start failure: the advertisement is a convenience. */
function parseCliVersion(value: string | undefined): string | null {
  const version = value?.trim();
  return isReleaseVersion(version) ? version : null;
}

const COMMIT = /^[0-9a-f]{7,40}$/;

/** CI passes the full commit SHA; anything else is "unknown", like the CLI version. */
function parseRevision(value: string | undefined): string | null {
  const revision = value?.trim().toLowerCase();
  return revision !== undefined && COMMIT.test(revision) ? revision : null;
}

const MAX_LABEL_LENGTH = 40;

/** Button text from the operator; it ends up in the browser, so it is plain and short. */
function parseLabel(env: Env, name: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const label = (env[name] ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  return label.slice(0, MAX_LABEL_LENGTH) || fallback;
}

function parseUrl(name: string, value: string, nodeEnv: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a URL`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && nodeEnv !== 'production'))
    throw new Error(`${name} must be an https URL${nodeEnv === 'production' ? '' : ' (or http)'}`);
  return url;
}

function parsePublicUrl(value: string, nodeEnv: string): URL {
  const url = parseUrl('PUBLIC_URL', value, nodeEnv);
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password)
    throw new Error('PUBLIC_URL must be an origin: scheme, host and port, no path or query');
  return url;
}

function parseOnOff(env: Env, name: string, fallback: boolean): boolean {
  const value = optionalEnv(env, name)?.toLowerCase();
  if (!value) return fallback;
  if (value !== 'on' && value !== 'off') throw new Error(`${name} must be "on" or "off"`);
  return value === 'on';
}

function parseSessionDays(env: Env): number {
  const raw = optionalEnv(env, 'SESSION_DAYS');
  if (!raw) return 30;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 365)
    throw new Error('SESSION_DAYS must be a whole number from 1 to 365');
  return days;
}

function parseSignupToken(env: Env, passkeys: boolean): string | null {
  const token = optionalEnv(env, 'SIGNUP_TOKEN');
  if (!token) return null;
  if (token.length < 32) throw new Error('SIGNUP_TOKEN must be at least 32 characters');
  if (!passkeys) throw new Error('SIGNUP_TOKEN needs PASSKEYS=on: an account is created with a passkey');
  return token;
}

function parseOidc(env: Env, nodeEnv: string): OidcConfig | null {
  const issuer = optionalEnv(env, 'OIDC_ISSUER');
  const clientId = optionalEnv(env, 'OIDC_CLIENT_ID');
  const clientSecret = optionalEnv(env, 'OIDC_CLIENT_SECRET');
  if (!issuer) {
    if (clientId || clientSecret) throw new Error('OIDC_CLIENT_ID and OIDC_CLIENT_SECRET need OIDC_ISSUER');
    return null;
  }
  if (!clientId || !clientSecret) throw new Error('OIDC_ISSUER needs OIDC_CLIENT_ID and OIDC_CLIENT_SECRET');
  const scopes = optionalEnv(env, 'OIDC_SCOPES') ?? 'openid profile email';
  if (!scopes.split(/\s+/).includes('openid')) throw new Error('OIDC_SCOPES must include openid');
  return {
    issuer: parseUrl('OIDC_ISSUER', issuer, nodeEnv),
    clientId,
    clientSecret,
    scopes,
    usernameClaim: optionalEnv(env, 'OIDC_USERNAME_CLAIM') ?? 'preferred_username',
    groupsClaim: optionalEnv(env, 'OIDC_GROUPS_CLAIM') ?? 'groups',
    label: parseLabel(env, 'OIDC_LABEL', 'Single sign-on'),
  };
}

function readIdpCert(env: Env): string {
  const inline = optionalEnv(env, 'SAML_IDP_CERT');
  const file = optionalEnv(env, 'SAML_IDP_CERT_FILE');
  if (inline && file) throw new Error('Set SAML_IDP_CERT or SAML_IDP_CERT_FILE, not both');
  if (inline) return inline;
  if (!file) throw new Error('SAML_ENTRY_POINT needs SAML_IDP_CERT or SAML_IDP_CERT_FILE');
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    throw new Error(`SAML_IDP_CERT_FILE ${file} cannot be read`);
  }
}

function parseSaml(env: Env, nodeEnv: string, publicUrl: string): SamlConfig | null {
  const entryPoint = optionalEnv(env, 'SAML_ENTRY_POINT');
  if (!entryPoint) {
    if (optionalEnv(env, 'SAML_IDP_CERT') || optionalEnv(env, 'SAML_IDP_CERT_FILE'))
      throw new Error('SAML_IDP_CERT needs SAML_ENTRY_POINT');
    return null;
  }
  return {
    entryPoint: parseUrl('SAML_ENTRY_POINT', entryPoint, nodeEnv).toString(),
    idpCert: readIdpCert(env),
    issuer: optionalEnv(env, 'SAML_ISSUER') ?? publicUrl,
    usernameAttribute: optionalEnv(env, 'SAML_USERNAME_ATTRIBUTE'),
    label: parseLabel(env, 'SAML_LABEL', 'SAML sign-on'),
  };
}

const SIGN_IN_VARIABLE = /^(OIDC_|SAML_)/;
const SIGN_IN_SETTINGS = ['SIGNUP_TOKEN', 'PUBLIC_URL', 'PASSKEYS', 'SESSION_DAYS', 'ALLOWED_GROUPS'];

function signInVariablesSet(env: Env): string[] {
  return Object.keys(env).filter(
    (name) => (SIGN_IN_VARIABLE.test(name) || SIGN_IN_SETTINGS.includes(name)) && optionalEnv(env, name) !== null,
  );
}

function parseNoLogin(env: Env, nodeEnv: string): NoLoginConfig | null {
  if (nodeEnv === 'production' && optionalEnv(env, 'DEV_AUTH_USER'))
    throw new Error('DEV_AUTH_USER is for development only: use NO_LOGIN_USER');
  const raw = optionalEnv(env, 'NO_LOGIN_USER') ?? optionalEnv(env, 'DEV_AUTH_USER');
  if (!raw) return null;
  const user = parseUsername(raw);
  if (!user) throw new Error('NO_LOGIN_USER must be a name of 1 to 128 characters without whitespace');
  const conflicting = signInVariablesSet(env);
  if (conflicting.length > 0)
    throw new Error(`NO_LOGIN_USER switches login off, so ${conflicting.join(', ')} would do nothing: unset one side`);
  return { login: false, user };
}

function parseLogin(env: Env, nodeEnv: string): LoginConfig {
  const publicUrl = optionalEnv(env, 'PUBLIC_URL');
  if (!publicUrl)
    throw new Error(
      "Set PUBLIC_URL (the board's address in the browser) to sign users in, or NO_LOGIN_USER to run without login",
    );
  const url = parsePublicUrl(publicUrl, nodeEnv);
  const passkeys = parseOnOff(env, 'PASSKEYS', true);
  const oidc = parseOidc(env, nodeEnv);
  const saml = parseSaml(env, nodeEnv, url.origin);
  const allowedGroups = (env.ALLOWED_GROUPS ?? '')
    .split(',')
    .map((group) => group.trim())
    .filter(Boolean);
  if (allowedGroups.length > 0 && !oidc)
    throw new Error('ALLOWED_GROUPS needs OIDC_ISSUER: only OIDC sends groups, so nothing else would check it');
  if (!passkeys && !oidc && !saml)
    throw new Error('No way to sign in: leave PASSKEYS on, or set OIDC_ISSUER or SAML_ENTRY_POINT');
  return {
    login: true,
    publicUrl: url.origin,
    rpId: url.hostname,
    sessionDays: parseSessionDays(env),
    passkeys,
    signupToken: parseSignupToken(env, passkeys),
    allowedGroups,
    oidc,
    saml,
  };
}

function parseAllowedHosts(env: Env): string[] {
  const hosts = (optionalEnv(env, 'ALLOWED_HOSTS') ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (hosts.some((host) => /[/@\s]|:\/\//.test(host)))
    throw new Error('ALLOWED_HOSTS entries must be host or host:port');
  return hosts;
}

export function loadConfig(env: Env = process.env): Config {
  const nodeEnv = env.NODE_ENV ?? 'development';
  return {
    nodeEnv,
    port: Number(env.PORT ?? 4000),
    databaseUrl: requireEnv(env, 'DATABASE_URL'),
    appDatabaseUrl: requireEnv(env, 'APP_DATABASE_URL'),
    backfillOwner: env.BACKFILL_OWNER?.trim().toLowerCase() || null,
    auth: parseNoLogin(env, nodeEnv) ?? parseLogin(env, nodeEnv),
    allowedHosts: parseAllowedHosts(env),
    cliVersion: parseCliVersion(env.CLI_VERSION),
    revision: parseRevision(env.GIT_SHA),
  };
}
