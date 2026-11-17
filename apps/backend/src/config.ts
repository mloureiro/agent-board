import { isReleaseVersion } from '@agent-board/shared';

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};

export interface Config {
  nodeEnv: string;
  port: number;
  /** The address to listen on; every interface unless HOST names one. */
  host: string;
  /** Owner/admin connection: bootstrap and migrations only. */
  databaseUrl: string;
  /** The unprivileged `board_app` connection that serves every request. */
  appDatabaseUrl: string;
  /** Owner for rows that predate tenancy; read only by the migration that adds owners. */
  backfillOwner: string | null;
  /** Authelia groups that may use the board. */
  allowedGroups: string[];
  /** Local development only: act as this user instead of reading Authelia headers. */
  devAuthUser: string | null;
  /** Shared secret the web proxy adds as Board-Proxy-Secret; the Remote-* headers count only with it. Null outside production means no check. */
  proxySecret: string | null;
  /** The newest CLI release, x.y.z, which the machine API advertises; null when this build does not know it. */
  cliVersion: string | null;
}

/** An unset or malformed value is "unknown", not a start failure: the advertisement is a convenience. */
function parseCliVersion(value: string | undefined): string | null {
  const version = value?.trim();
  return isReleaseVersion(version) ? version : null;
}

function loadProxySecret(nodeEnv: string): string | null {
  const secret = process.env.PROXY_SECRET?.trim();
  if (!secret) {
    if (nodeEnv === 'production') throw new Error('PROXY_SECRET must be set in production');
    return null;
  }
  if (secret.length < 32) throw new Error('PROXY_SECRET must be at least 32 characters');
  return secret;
}

export function loadConfig(): Config {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const devAuthUser = process.env.DEV_AUTH_USER?.trim() || null;
  if (devAuthUser && nodeEnv === 'production') {
    throw new Error('DEV_AUTH_USER must not be set in production');
  }
  const backfillOwner = process.env.BACKFILL_OWNER?.trim().toLowerCase() || null;
  return {
    nodeEnv,
    port: Number(process.env.PORT ?? 4000),
    host: process.env.HOST?.trim() || '0.0.0.0',
    databaseUrl: requireEnv('DATABASE_URL'),
    appDatabaseUrl: requireEnv('APP_DATABASE_URL'),
    backfillOwner,
    allowedGroups: (process.env.ALLOWED_GROUPS ?? 'admins')
      .split(',')
      .map((g) => g.trim())
      .filter(Boolean),
    devAuthUser,
    proxySecret: loadProxySecret(nodeEnv),
    cliVersion: parseCliVersion(process.env.CLI_VERSION),
  };
}
