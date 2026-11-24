import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '@agent-board/shared';
import { SystemError } from '../setup/system.mts';
import { backupsDir, VERSION_PATTERN, writeFileAtomic } from './layout.mts';
import type { UnitFiles } from './units.mts';

export type BackupKind = 'update' | 'steps' | 'server';

export interface BackupFile {
  path: string;
  sha256: string;
  mode: number;
}

export interface BackupManifest {
  version: 1;
  kind: BackupKind;
  createdAt: string;
  from: string;
  to: string;
  cliApi: number;
  binaryPath?: string;
  configDir: string;
  unitDir: string;
  platform: string;
  files: BackupFile[];
  rolledBackAt: string | null;
}

export interface BackupInput {
  stateDir: string;
  kind: BackupKind;
  from: string;
  to: string;
  cliApi: number;
  binaryPath?: string;
  configDir: string;
  unitFiles: UnitFiles;
  platform: string;
  now: Date;
}

export interface BackupEntry {
  name: string;
  dir: string;
  manifest: BackupManifest;
}

const MANIFEST = 'manifest.json';
const KINDS: readonly string[] = ['update', 'steps', 'server'];
const STORED_PATH = /^(board|config\/[^/]+|units\/[^/]+)$/;

const sha256Of = (content: Buffer): string => createHash('sha256').update(content).digest('hex');

function ownRoot(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const info = lstatSync(root);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new SystemError(`${root} is not a plain directory; backups hold the machine token, so nothing was written`);
  if (process.getuid !== undefined && info.uid !== process.getuid())
    throw new SystemError(`${root} belongs to another user; backups hold the machine token, so nothing was written`);
  if ((info.mode & 0o777) !== 0o700) chmodSync(root, 0o700);
}

function stampOf(now: Date): string {
  return now
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/:/g, '-');
}

export function createBackup(input: BackupInput): BackupEntry {
  const root = backupsDir(input.stateDir);
  ownRoot(root);
  const name = `${stampOf(input.now)}-${input.kind}-${input.from}-${input.to}`;
  const dir = join(root, name);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw new SystemError(`the backup ${dir} exists already`);
    throw error;
  }
  const files: BackupFile[] = [];
  const store = (stored: string, content: Buffer, mode: number): void => {
    const target = join(dir, stored);
    mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
    files.push({ path: stored, sha256: sha256Of(content), mode });
  };
  const regularFile = (path: string): { content: Buffer; mode: number } | undefined => {
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (info === undefined || !info.isFile()) return undefined;
    return { content: readFileSync(path), mode: info.mode & 0o777 };
  };
  if (input.kind === 'update') {
    if (input.binaryPath === undefined) throw new SystemError('a backup of kind update needs the binary to keep');
    const binary = regularFile(input.binaryPath);
    if (binary === undefined) throw new SystemError(`cannot back up ${input.binaryPath}: it is not a regular file`);
    store('board', binary.content, binary.mode);
  }
  for (const entry of readdirSync(input.configDir, { withFileTypes: true })) {
    const file = entry.isFile() ? regularFile(join(input.configDir, entry.name)) : undefined;
    if (file !== undefined) store(`config/${entry.name}`, file.content, file.mode);
  }
  for (const unit of input.unitFiles.names) {
    const file = regularFile(join(input.unitFiles.dir, unit));
    if (file !== undefined) store(`units/${unit}`, file.content, file.mode);
  }
  const manifest: BackupManifest = {
    version: 1,
    kind: input.kind,
    createdAt: input.now.toISOString(),
    from: input.from,
    to: input.to,
    cliApi: input.cliApi,
    ...(input.kind === 'update' && input.binaryPath !== undefined ? { binaryPath: input.binaryPath } : {}),
    configDir: input.configDir,
    unitDir: input.unitFiles.dir,
    platform: input.platform,
    files,
    rolledBackAt: null,
  };
  writeFileAtomic(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
  return { name, dir, manifest };
}

function parseFile(value: unknown): BackupFile | undefined {
  if (!isRecord(value)) return undefined;
  const { path, sha256, mode } = value;
  if (typeof path !== 'string' || !STORED_PATH.test(path) || path.includes('..')) return undefined;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return undefined;
  if (typeof mode !== 'number' || !Number.isInteger(mode) || mode < 0 || mode > 0o777) return undefined;
  return { path, sha256, mode };
}

export function parseManifest(raw: unknown): BackupManifest | undefined {
  if (!isRecord(raw) || raw['version'] !== 1) return undefined;
  const { kind, createdAt, from, to, cliApi, binaryPath, configDir, unitDir, platform, rolledBackAt } = raw;
  if (typeof kind !== 'string' || !KINDS.includes(kind)) return undefined;
  if (typeof from !== 'string' || !VERSION_PATTERN.test(from)) return undefined;
  if (typeof to !== 'string' || !VERSION_PATTERN.test(to)) return undefined;
  if (typeof cliApi !== 'number' || !Number.isInteger(cliApi) || cliApi < 0) return undefined;
  if (typeof createdAt !== 'string' || typeof platform !== 'string') return undefined;
  if (typeof configDir !== 'string' || typeof unitDir !== 'string') return undefined;
  if (binaryPath !== undefined && typeof binaryPath !== 'string') return undefined;
  if (rolledBackAt !== null && typeof rolledBackAt !== 'string') return undefined;
  if (!Array.isArray(raw['files'])) return undefined;
  const files = raw['files'].map(parseFile);
  if (files.some((file) => file === undefined)) return undefined;
  return {
    version: 1,
    kind: kind as BackupKind,
    createdAt,
    from,
    to,
    cliApi,
    ...(binaryPath === undefined ? {} : { binaryPath }),
    configDir,
    unitDir,
    platform,
    files: files as BackupFile[],
    rolledBackAt,
  };
}

function manifestOf(dir: string): BackupManifest | undefined {
  try {
    return parseManifest(JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')));
  } catch {
    return undefined;
  }
}

// Newest first; a directory without a readable manifest is an unfinished backup and is not listed.
export function listBackups(stateDir: string): BackupEntry[] {
  const root = backupsDir(stateDir);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .sort()
    .reverse()
    .flatMap((name) => {
      const dir = join(root, name);
      const manifest = manifestOf(dir);
      return manifest === undefined ? [] : [{ name, dir, manifest }];
    });
}

export type BackupVerdict = { ok: true; manifest: BackupManifest } | { ok: false; problem: string };

export function verifyBackup(dir: string): BackupVerdict {
  const manifest = manifestOf(dir);
  if (manifest === undefined) return { ok: false, problem: `${join(dir, MANIFEST)} is missing or not readable` };
  for (const file of manifest.files) {
    const path = join(dir, file.path);
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (info === undefined || !info.isFile()) return { ok: false, problem: `${path} is missing` };
    if (sha256Of(readFileSync(path)) !== file.sha256) return { ok: false, problem: `${path} was changed` };
  }
  return { ok: true, manifest };
}

export function pruneBackups(stateDir: string, keep = 3, protect: readonly string[] = []): string[] {
  const removed: string[] = [];
  for (const entry of listBackups(stateDir).slice(keep)) {
    if (protect.includes(entry.name)) continue;
    rmSync(entry.dir, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}
