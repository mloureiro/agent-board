import type { Machine } from '@agent-board/shared/ui';

/** How a machine's CLI compares with the board, as the server judged it. */
export type ClientStatus = Machine['clientStatus'];

/** What the Settings page says about a machine's CLI. */
export function clientText({ clientVersion, clientStatus }: Pick<Machine, 'clientVersion' | 'clientStatus'>): string {
  const version = clientVersion ?? '';
  const joined = (note: string): string => (version === '' ? note : `${version} · ${note}`);
  switch (clientStatus) {
    case 'current':
      return version;
    case 'outdated':
      return joined('update available');
    case 'incompatible':
      return joined('incompatible — run board self-update');
    case 'unknown':
      return 'version unknown';
  }
}

export const CLIENT_COLOR: Record<ClientStatus, string> = {
  current: 'dimmed',
  outdated: 'orange',
  incompatible: 'red',
  unknown: 'dimmed',
};

export const RECENT_MS = 24 * 60 * 60 * 1000;

/** Machines whose CLI the board refuses and that were seen lately: a revoked token or a machine long gone is no news. */
export function incompatibleMachines(machines: readonly Machine[], now: number = Date.now()): Machine[] {
  return machines.filter(
    ({ clientStatus, revokedAt, lastSeenAt }) =>
      clientStatus === 'incompatible' &&
      revokedAt === null &&
      lastSeenAt !== null &&
      now - new Date(lastSeenAt).getTime() < RECENT_MS,
  );
}
