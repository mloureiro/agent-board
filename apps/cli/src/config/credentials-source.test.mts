import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ConfigError } from './config.mts';
import { credentialsCommandOf, loadCredentials, runCredentialsCommand } from './credentials-source.mts';

const TOKEN_LINE = 'AGENT_BOARD_TOKEN=abm_secretsecretsecret';
const KEY_LINE = 'AGENT_BOARD_DATA_KEY=abk1_secretsecretsecretsecretsecretsecretsecret';

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'board-credentials-source-test-'));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function script(name: string, body: string, mode = 0o755): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, mode);
  return path;
}

function refusal(command: string, timeoutMs?: number): string {
  try {
    runCredentialsCommand(command, timeoutMs === undefined ? {} : { timeoutMs });
  } catch (error) {
    assert.ok(error instanceof ConfigError, 'a ConfigError');
    return error.message;
  }
  return assert.fail('the command was accepted');
}

test('a command printing both lines gives both values', () => {
  const command = script('both', `echo '${TOKEN_LINE}'\necho '${KEY_LINE}'`);
  assert.deepEqual(runCredentialsCommand(command), {
    AGENT_BOARD_TOKEN: 'abm_secretsecretsecret',
    AGENT_BOARD_DATA_KEY: 'abk1_secretsecretsecretsecretsecretsecretsecret',
  });
});

test('a command that prints one line names the value it lacks and not the one it printed', () => {
  const command = script('token-only', `echo '${TOKEN_LINE}'`);
  const message = refusal(command);
  assert.match(message, /AGENT_BOARD_DATA_KEY/);
  assert.doesNotMatch(message, /abm_/);
});

test('a failing command reports its exit code and withholds a secret on stderr', () => {
  const leaking = script('leaks', `echo 'bad key abk1_secretsecret' >&2\necho '${TOKEN_LINE}'\nexit 3`);
  const message = refusal(leaking);
  assert.match(message, /code 3/);
  assert.match(message, /\(withheld\)/);
  assert.doesNotMatch(message, /abk1_|abm_/);

  const plain = script('plain', "echo 'keychain locked' >&2\necho 'second line' >&2\nexit 1");
  const plainMessage = refusal(plain);
  assert.match(plainMessage, /keychain locked/);
  assert.doesNotMatch(plainMessage, /second line/);
});

test('a relative path, a file that is not executable and a missing file are refused', () => {
  assert.match(refusal('bin/creds'), /absolute/);
  assert.match(refusal(script('plain-file', 'true', 0o644)), /not an executable/);
  assert.match(refusal(join(dir, 'missing')), /not an executable/);
});

test('a command that outlives the timeout is refused', () => {
  const command = script('slow', 'sleep 5');
  assert.match(refusal(command, 100), /timed out/);
});

test('a command that ignores SIGTERM is still stopped at the timeout', () => {
  const command = script('stubborn', 'trap "" TERM\nwhile :; do sleep 1; done');
  const started = Date.now();
  assert.match(refusal(command, 300), /timed out/);
  assert.ok(Date.now() - started < 4000, 'returned shortly after the timeout');
});

test('the command is the only source: an env file beside it is not read or merged', () => {
  const command = script('only', `echo '${TOKEN_LINE}'\necho '${KEY_LINE}'`);
  writeFileSync(join(dir, 'env'), 'AGENT_BOARD_TOKEN=abm_fromfile\nAGENT_BOARD_DATA_KEY=ignored\nEXTRA=1\n', {
    mode: 0o600,
  });
  const source = loadCredentials(dir, { AGENT_BOARD_CREDENTIALS_COMMAND: command });
  assert.equal(source.viaCommand, true);
  assert.equal(source.from, command);
  assert.equal(source.values['AGENT_BOARD_TOKEN'], 'abm_secretsecretsecret');
  assert.equal(source.values['EXTRA'], undefined);
  const fromFile = loadCredentials(dir, {});
  assert.equal(fromFile.viaCommand, false);
  assert.equal(fromFile.values['EXTRA'], '1');
});

test('an unset or empty variable means no command', () => {
  assert.equal(credentialsCommandOf({}), undefined);
  assert.equal(credentialsCommandOf({ AGENT_BOARD_CREDENTIALS_COMMAND: '' }), undefined);
});
