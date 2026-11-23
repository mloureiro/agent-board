import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tempDir } from '../__tests__/helpers/watch.mts';
import { checkInstallUrl } from './url.mts';

test('checkInstallUrl allows the https, ssh, scp-like and local forms', () => {
  const local = tempDir();
  for (const url of [
    'https://github.com/mloureiro/agent-board-plugins',
    'https://git.example.com:8443/team/repo.git',
    'ssh://git@github.com/mloureiro/agent-board-plugins.git',
    'ssh://git@example.com:2222/team/repo',
    'git@github.com:mloureiro/agent-board-plugins.git',
    local,
  ])
    assert.equal(checkInstallUrl(url), undefined, url);
});

test('checkInstallUrl refuses every other transport, option-like and malformed text', () => {
  const missing = `${tempDir()}/nope`;
  for (const url of [
    '',
    'http://github.com/a/b',
    'git://github.com/a/b',
    'ext::sh -c x',
    'ext::sh%20-c%20x',
    'file:///srv/repo',
    '-u/tmp/x',
    '--upload-pack=touch /tmp/x',
    'https://github.com/a/b c',
    'https://github.com/a/b\n',
    'https://github.com/a/b?x=1',
    'https://user:pw@github.com/a/b',
    'relative/path',
    missing,
    `https://github.com/${'a'.repeat(500)}`,
  ])
    assert.notEqual(checkInstallUrl(url), undefined, JSON.stringify(url));
});

test('checkInstallUrl refuses an absolute path that is a file', () => {
  assert.match(checkInstallUrl('/etc/hosts') ?? '', /existing directory/);
});
