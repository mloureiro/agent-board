import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { encodeDataKey } from '@agent-board/shared';
import { fakeBoard } from './helpers/fake-board.mts';
import { DATA_KEY } from './helpers/fakes.mts';

const MAIN = fileURLToPath(new URL('../main.mts', import.meta.url));
const KEY_TEXT = encodeDataKey(DATA_KEY);

// Types into the real prompts of `board init` through a pty: clack submits an answer on the first Enter, which a fake
// prompt cannot show. Python's pty module is the helper; without it the test is skipped.
const DRIVER = `
import fcntl, os, pty, select, struct, sys, termios, time
node, main, cfg, home, token, key, url = sys.argv[1:8]
env = {'HOME': home, 'AGENT_BOARD_CONFIG_DIR': cfg, 'XDG_CONFIG_HOME': home + '/xdg', 'PATH': '/usr/bin:/bin', 'TERM': 'xterm-256color'}
pid, fd = pty.fork()
if pid == 0:
    # A terminal with no width makes clack wrap every character.
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 160, 0, 0))
    os.execve(node, [node, main, 'init', '--url', url, '--machine', 'box'], env)
out = b''
def expect(text, seconds):
    global out
    end = time.time() + seconds
    while text not in out and time.time() < end:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return
            if not data:
                return
            out += data
expect(b'Machine token', 20)
os.write(fd, (token + '\\r').encode())
expect(b'Data key', 20)
os.write(fd, (key + '\\r').encode())
end = time.time() + 30
status = None
while time.time() < end:
    ready, _, _ = select.select([fd], [], [], 0.1)
    if ready:
        try:
            data = os.read(fd, 65536)
            if data:
                out += data
        except OSError:
            pass
    done, st = os.waitpid(pid, os.WNOHANG)
    if done:
        status = st
        break
sys.stdout.write(out.decode('utf8', 'replace'))
sys.exit(0 if status is not None else 3)
`;

function ptyAvailable(): boolean {
  return spawnSync('python3', ['-c', 'import pty, select'], { stdio: 'ignore' }).status === 0;
}

async function typeInto(token: string, key: string, url: string): Promise<{ dir: string; transcript: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'board-pty-test-'));
  const result = await new Promise<{ status: number; output: string }>((resolve) => {
    execFile(
      'python3',
      ['-I', '-c', DRIVER, process.execPath, MAIN, join(dir, 'cfg'), dir, token, key, url],
      { encoding: 'utf8', timeout: 90_000 },
      (error, stdout, stderr) =>
        resolve({
          status: error === null ? 0 : typeof error.code === 'number' ? error.code : -1,
          output: stderr + stdout,
        }),
    );
  });
  assert.equal(result.status, 0, `the pty driver failed: ${result.output}`);
  return { dir, transcript: result.output };
}

for (const [name, token, key] of [
  ['bare values', 'abm_typed-at-a-terminal', KEY_TEXT],
  [
    'the NAME=value lines the Settings page copies',
    'AGENT_BOARD_TOKEN=abm_typed-at-a-terminal',
    `AGENT_BOARD_DATA_KEY=${KEY_TEXT}`,
  ],
] as const) {
  test(`a person answers the real prompts of board init with ${name}, one line each`, async (context: TestContext) => {
    if (!ptyAvailable()) return context.skip('python3 with the pty module is not available');
    const board = await fakeBoard();
    const { dir, transcript } = await typeInto(token, key, board.url).finally(() => board.close());
    try {
      assert.equal(
        readFileSync(join(dir, 'cfg', 'env'), 'utf8'),
        `AGENT_BOARD_TOKEN=abm_typed-at-a-terminal\nAGENT_BOARD_DATA_KEY=${KEY_TEXT}\n`,
      );
      assert.ok(
        !transcript.includes(KEY_TEXT) && !transcript.includes('abm_typed-at-a-terminal'),
        'a secret was echoed',
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
}
