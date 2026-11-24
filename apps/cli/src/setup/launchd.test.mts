import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isSafeTaskId } from '@agent-board/shared';
import {
  agentLog,
  agentPath,
  bootstrapCommand,
  parseProgramArguments,
  passedEnv,
  renderAgents,
  xmlEscape,
} from './launchd.mts';
import type { LaunchdRenderInput } from './launchd.mts';
import { SystemError } from './system.mts';

const input: LaunchdRenderInput = {
  home: '/Users/me',
  lockf: '/usr/bin/lockf',
  lockDir: '/Users/me/.local/state/agent-board/run',
  logDir: '/Users/me/.local/state/agent-board/logs',
  command: (name) => ['/Users/me/.local/bin/board', 'internal', name],
};

const [dispatch, listen, watch] = renderAgents(input);

test('there are three agents, dispatch, listen and watch, and none for intake', () => {
  assert.deepEqual(
    [dispatch?.file, listen?.file, watch?.file],
    [
      'de.codeplant.agent-board.dispatch.plist',
      'de.codeplant.agent-board.listen.plist',
      'de.codeplant.agent-board.watch.plist',
    ],
  );
});

test('the dispatch agent runs a tick every 2 minutes and at load, under lockf, and leaves its workers alone', () => {
  assert.equal(
    dispatch?.text,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>de.codeplant.agent-board.dispatch</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/usr/bin/lockf</string>
\t\t<string>-s</string>
\t\t<string>-t</string>
\t\t<string>0</string>
\t\t<string>/Users/me/.local/state/agent-board/run/agent-board-dispatch.lock</string>
\t\t<string>/Users/me/.local/bin/board</string>
\t\t<string>internal</string>
\t\t<string>dispatch</string>
\t</array>
\t<key>StartInterval</key>
\t<integer>120</integer>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>AbandonProcessGroup</key>
\t<true/>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>/Users/me/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
\t</dict>
\t<key>StandardOutPath</key>
\t<string>/Users/me/.local/state/agent-board/logs/launchd.dispatch.log</string>
\t<key>StandardErrorPath</key>
\t<string>/Users/me/.local/state/agent-board/logs/launchd.dispatch.log</string>
</dict>
</plist>
`,
  );
});

test('the listener is kept alive, restarted every 10 s, and given 120 s to end a running tick', () => {
  const text = listen?.text ?? '';
  assert.match(text, /<key>KeepAlive<\/key>\n\t<true\/>/);
  assert.match(text, /<key>RunAtLoad<\/key>\n\t<true\/>/);
  assert.match(text, /<key>ThrottleInterval<\/key>\n\t<integer>10<\/integer>/);
  assert.match(text, /<key>ExitTimeOut<\/key>\n\t<integer>130<\/integer>/);
  assert.match(text, /<key>AbandonProcessGroup<\/key>\n\t<true\/>/);
  assert.deepEqual(parseProgramArguments(text), ['/Users/me/.local/bin/board', 'internal', 'listen']);
  assert.doesNotMatch(text, /StartInterval/);
});

test("the watch agent is kept alive and restarted every 5 s, with the listener's environment", () => {
  const text = watch?.text ?? '';
  assert.match(text, /<key>KeepAlive<\/key>\n\t<true\/>/);
  assert.match(text, /<key>RunAtLoad<\/key>\n\t<true\/>/);
  assert.match(text, /<key>ThrottleInterval<\/key>\n\t<integer>5<\/integer>/);
  assert.match(text, /<key>AbandonProcessGroup<\/key>\n\t<true\/>/);
  assert.match(text, /<key>PATH<\/key>\n\t\t<string>\/Users\/me\/\.local\/bin:/);
  assert.deepEqual(parseProgramArguments(text), ['/Users/me/.local/bin/board', 'internal', 'watch']);
  assert.doesNotMatch(text, /StartInterval|ExitTimeOut/);
});

test('the PATH is written out, and the variables that move the CLI files are passed on', () => {
  assert.equal(
    agentPath('/Users/me'),
    '/Users/me/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  );
  assert.deepEqual(passedEnv({ AGENT_BOARD_STATE_DIR: '/s', XDG_STATE_HOME: '', HOME: '/h', PATH: '/x' }), {
    AGENT_BOARD_STATE_DIR: '/s',
  });
  const [withEnv] = renderAgents({ ...input, env: { AGENT_BOARD_STATE_DIR: '/s' } });
  assert.match(withEnv?.text ?? '', /<key>AGENT_BOARD_STATE_DIR<\/key>\n\t\t<string>\/s<\/string>/);
});

test('every string is XML-escaped and a control character is refused', () => {
  assert.equal(xmlEscape(`a&b<c>"d"'e'`), 'a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;');
  assert.throws(() => xmlEscape('a\u0000b'), SystemError);
  assert.throws(() => xmlEscape('a\u001bb'), SystemError);
  const odd = '/Users/o\'brien & <co>/board "x"';
  const [rendered] = renderAgents({ ...input, command: () => [odd, 'internal', 'dispatch'] });
  assert.ok(!rendered?.text.includes(odd), 'not written raw');
  assert.deepEqual(parseProgramArguments(rendered?.text ?? '')?.slice(5), [odd, 'internal', 'dispatch']);
  assert.throws(() => renderAgents({ ...input, home: '/Users/a\u0001b' }).map((a) => a.text), SystemError);
});

test('the launchd logs cannot be taken for the log of a task', () => {
  for (const name of ['dispatch', 'listen', 'watch'] as const) {
    const file = agentLog('/logs', name).split('/').pop() ?? '';
    assert.ok(file.endsWith('.log'));
    assert.equal(isSafeTaskId(file.slice(0, -'.log'.length)), false, file);
  }
});

test('the bootstrap line quotes the plist path', () => {
  assert.equal(
    bootstrapCommand(501, '/Users/me/Library/LaunchAgents/x.plist'),
    "launchctl bootstrap gui/501 '/Users/me/Library/LaunchAgents/x.plist'",
  );
});

test('plutil accepts the rendered files (macOS only)', { skip: process.platform !== 'darwin' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-plutil-test-'));
  try {
    for (const agent of renderAgents({ ...input, command: () => ['/odd & <name>/board', 'internal', 'x'] })) {
      const path = join(dir, agent.file);
      writeFileSync(path, agent.text);
      execFileSync('plutil', ['-lint', path]);
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});

const GOLDEN_HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
`;

const goldenTail = (name: string): string => `\t<key>AbandonProcessGroup</key>
\t<true/>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>/Users/me/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
\t\t<key>AGENT_BOARD_STATE_DIR</key>
\t\t<string>/s</string>
\t</dict>
\t<key>StandardOutPath</key>
\t<string>/Users/me/.local/state/agent-board/logs/launchd.${name}.log</string>
\t<key>StandardErrorPath</key>
\t<string>/Users/me/.local/state/agent-board/logs/launchd.${name}.log</string>
</dict>
</plist>
`;

test('the three agents are rendered key for key, with a passed variable after PATH', () => {
  const [d, l, w] = renderAgents({ ...input, env: { AGENT_BOARD_STATE_DIR: '/s' } });
  assert.equal(
    d?.text,
    `${GOLDEN_HEAD}\t<key>Label</key>
\t<string>de.codeplant.agent-board.dispatch</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/usr/bin/lockf</string>
\t\t<string>-s</string>
\t\t<string>-t</string>
\t\t<string>0</string>
\t\t<string>/Users/me/.local/state/agent-board/run/agent-board-dispatch.lock</string>
\t\t<string>/Users/me/.local/bin/board</string>
\t\t<string>internal</string>
\t\t<string>dispatch</string>
\t</array>
\t<key>StartInterval</key>
\t<integer>120</integer>
\t<key>RunAtLoad</key>
\t<true/>
${goldenTail('dispatch')}`,
  );
  assert.equal(
    l?.text,
    `${GOLDEN_HEAD}\t<key>Label</key>
\t<string>de.codeplant.agent-board.listen</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/Users/me/.local/bin/board</string>
\t\t<string>internal</string>
\t\t<string>listen</string>
\t</array>
\t<key>KeepAlive</key>
\t<true/>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>ThrottleInterval</key>
\t<integer>10</integer>
\t<key>ExitTimeOut</key>
\t<integer>130</integer>
${goldenTail('listen')}`,
  );
  assert.equal(
    w?.text,
    `${GOLDEN_HEAD}\t<key>Label</key>
\t<string>de.codeplant.agent-board.watch</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/Users/me/.local/bin/board</string>
\t\t<string>internal</string>
\t\t<string>watch</string>
\t</array>
\t<key>KeepAlive</key>
\t<true/>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>ThrottleInterval</key>
\t<integer>5</integer>
${goldenTail('watch')}`,
  );
});
