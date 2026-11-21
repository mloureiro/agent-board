import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { VERSION_ANSWER } from './fakes.mts';

// A loopback board that answers only `version`, as the machine whose token it is given.
export async function fakeBoard(machine = 'box'): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    req.resume();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ result: { ...VERSION_ANSWER, machine } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
