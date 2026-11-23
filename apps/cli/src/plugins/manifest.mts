import { INTEGRATION_NAME, MARKETPLACE_NAME, isRecord } from '@agent-board/shared';
import type { GitRunner } from '../config/checkout-repo.mts';

export const MANIFEST_PATH = '.agent-board/marketplace.json';
export const PROTOCOL = 1;

const MAX_BYTES = 64 * 1024;
const MAX_FEEDS = 50;
const MAX_TEXT = 300;
const MAX_PROGRAM = 200;
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const COMMIT = /^[0-9a-f]{40}$/;

export const isCommit = (text: string): boolean => COMMIT.test(text);

export interface MarketplaceFeed {
  program: string;
  description: string | undefined;
}

export interface Marketplace {
  name: string;
  description: string | undefined;
  feeds: Record<string, MarketplaceFeed>;
}

const shown = (text: string): string => JSON.stringify(text.slice(0, 40));

function optionalText(value: unknown, where: string): string | undefined | { problem: string } {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > MAX_TEXT)
    return { problem: `${where} must be text of at most ${MAX_TEXT} characters` };
  return value;
}

function isProgramPath(program: string): boolean {
  if (program.length === 0 || program.length > MAX_PROGRAM) return false;
  return program.split('/').every((segment) => SEGMENT.test(segment) && segment !== '.' && segment !== '..');
}

function parseFeed(key: string, entry: unknown): MarketplaceFeed | string {
  const where = `feeds.${key}`;
  if (!isRecord(entry)) return `${where} must be an object`;
  const unknown = Object.keys(entry).find((name) => name !== 'program' && name !== 'description');
  if (unknown !== undefined) return `unknown key ${shown(unknown)} in the marketplace manifest`;
  const { program } = entry;
  if (typeof program !== 'string' || !isProgramPath(program))
    return `${where}.program must be a relative path of plain segments (letters, digits, dots, dashes, underscores)`;
  const description = optionalText(entry['description'], `${where}.description`);
  if (typeof description === 'object') return description.problem;
  return { program, description };
}

/** The manifest of a marketplace, or the reason it cannot be used. Fails closed on anything it does not know. */
export function parseMarketplace(text: string): Marketplace | string {
  if (Buffer.byteLength(text) > MAX_BYTES) return `the marketplace manifest is larger than ${MAX_BYTES / 1024} KiB`;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return 'the marketplace manifest is not valid JSON';
  }
  if (!isRecord(raw)) return 'the marketplace manifest must be a JSON object';
  const unknown = Object.keys(raw).find(
    (key) => key !== 'protocol' && key !== 'name' && key !== 'description' && key !== 'feeds',
  );
  if (unknown !== undefined) return `unknown key ${shown(unknown)} in the marketplace manifest`;
  if (raw['protocol'] !== PROTOCOL)
    return `marketplace speaks protocol ${String(raw['protocol']).slice(0, 20)}; this CLI speaks ${PROTOCOL}`;
  const { name, feeds } = raw;
  if (typeof name !== 'string' || !MARKETPLACE_NAME.test(name))
    return 'the marketplace name must be 1 to 40 lowercase letters, digits or dashes, starting with a letter or digit';
  const description = optionalText(raw['description'], 'description');
  if (typeof description === 'object') return description.problem;
  if (!isRecord(feeds)) return 'the marketplace manifest needs a feeds object (it may be empty)';
  const keys = Object.keys(feeds);
  if (keys.length > MAX_FEEDS) return `a marketplace lists at most ${MAX_FEEDS} feeds`;
  const parsed: Record<string, MarketplaceFeed> = {};
  for (const key of keys) {
    if (!INTEGRATION_NAME.test(key))
      return `feed name ${shown(key)} must be 1 to 40 lowercase letters, digits or dashes`;
    const feed = parseFeed(key, feeds[key]);
    if (typeof feed === 'string') return feed;
    parsed[key] = feed;
  }
  return { name, description, feeds: parsed };
}

/** Why `program` is not a tracked regular executable file at `commit`, or undefined when it is. */
export function programProblem(
  git: GitRunner,
  checkoutDir: string,
  commit: string,
  program: string,
): string | undefined {
  const listing = git(checkoutDir, ['ls-tree', commit, '--', program]);
  if (listing === undefined) return `git failed in ${checkoutDir}`;
  if (listing === '') return `program ${program} is not in the repository`;
  const entry = /^(\d{6}) (\w+) [0-9a-f]+\t(.*)$/.exec(listing);
  if (entry === null || entry[3] !== program) return `program ${program} is not a file in the repository`;
  if (entry[2] !== 'blob' || entry[1] === '120000')
    return `program ${program} must be a regular file, not a link or a directory`;
  if (entry[1] !== '100755') return `program ${program} is not executable (mode ${entry[1] ?? ''}, needs 100755)`;
  return undefined;
}

export function readMarketplace(git: GitRunner, checkoutDir: string, commit: string): Marketplace | string {
  const text = git(checkoutDir, ['show', `${commit}:${MANIFEST_PATH}`]);
  return text === undefined ? `no ${MANIFEST_PATH} at commit ${commit.slice(0, 12)}` : parseMarketplace(text);
}

export function loadMarketplace(git: GitRunner, checkoutDir: string, commit: string): Marketplace | string {
  const marketplace = readMarketplace(git, checkoutDir, commit);
  if (typeof marketplace === 'string') return marketplace;
  for (const [key, feed] of Object.entries(marketplace.feeds)) {
    const problem = programProblem(git, checkoutDir, commit, feed.program);
    if (problem !== undefined) return `${key}: ${problem}`;
  }
  return marketplace;
}
