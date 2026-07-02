import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, Server } from 'node:http';
import { AddressInfo, connect, Socket } from 'node:net';
import { GracefulShutdown } from '../src/lifecycle/gracefulShutdown';

/** Start a real HTTP server on an ephemeral loopback port. */
function startServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port });
    });
  });
}

test('resolves clean with no open connections and runs all stoppers', async () => {
  const { server } = await startServer();
  const calls: string[] = [];
  const gs = new GracefulShutdown(server, {
    timeoutMs: 1000,
    stoppers: [
      () => {
        calls.push('sync');
      },
      async () => {
        await Promise.resolve();
        calls.push('async');
      },
    ],
  });
  gs.install();

  const result = await gs.shutdown();
  assert.equal(result, 'clean');
  assert.deepEqual(calls.sort(), ['async', 'sync']);
});

test('a throwing stopper does not prevent others or block completion', async () => {
  const { server } = await startServer();
  const calls: string[] = [];
  const gs = new GracefulShutdown(server, {
    timeoutMs: 1000,
    stoppers: [
      () => {
        calls.push('before');
        throw new Error('boom');
      },
      async () => {
        calls.push('after');
      },
    ],
  });
  gs.install();

  const result = await gs.shutdown();
  assert.equal(result, 'clean');
  assert.deepEqual(calls, ['before', 'after']);
});

test('forced path destroys lingering idle sockets and closes the server', { timeout: 5000 }, async () => {
  const { server, port } = await startServer();
  const gs = new GracefulShutdown(server, { timeoutMs: 50 });
  gs.install();

  // Open a raw TCP connection and keep it idle (no complete HTTP request),
  // so the server cannot close cleanly and must force the socket shut.
  const client: Socket = await new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });

  // Observe the server forcibly ending our connection.
  const clientClosed = new Promise<void>((resolve) => {
    client.once('close', () => resolve());
  });

  try {
    const result = await gs.shutdown();
    assert.equal(result, 'forced');

    // The server destroyed the lingering socket, which closes the client end.
    await clientClosed;

    // The server should no longer be listening.
    assert.equal(server.listening, false);
  } finally {
    client.destroy();
  }
});
