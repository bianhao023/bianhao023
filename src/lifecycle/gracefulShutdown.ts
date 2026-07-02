import { Server } from 'node:http';
import { Socket } from 'node:net';

/** Result of a shutdown attempt: `'clean'` if the server drained in time, `'forced'` otherwise. */
export type ShutdownResult = 'clean' | 'forced';

/** Options controlling graceful-shutdown behaviour. */
export interface GracefulShutdownOptions {
  /** How long to wait for in-flight connections to drain before forcing. Default 10000ms. */
  timeoutMs?: number;
  /** Callbacks (e.g. queue drains, DB closes) run before the server stops accepting connections. */
  stoppers?: Array<() => void | Promise<void>>;
}

const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Drains and closes an HTTP server gracefully, forcing open sockets closed
 * once a timeout elapses. Designed to be unit-testable: it never calls
 * `process.exit`; instead `shutdown()` resolves with the outcome.
 */
export class GracefulShutdown {
  /** Sockets currently open against the server, tracked via `install()`. */
  private readonly sockets: Set<Socket> = new Set();
  /** Whether `install()` has already subscribed to connection events. */
  private installed = false;
  /** Memoised shutdown promise so repeated calls are idempotent. */
  private shutdownPromise: Promise<ShutdownResult> | null = null;

  constructor(
    private readonly server: Server,
    private readonly opts: GracefulShutdownOptions = {},
  ) {}

  /**
   * Begin tracking open connections so they can be forcibly destroyed on
   * timeout. Safe to call multiple times; only the first call subscribes.
   */
  install(): void {
    if (this.installed) return;
    this.installed = true;
    this.server.on('connection', (socket: Socket) => {
      this.sockets.add(socket);
      socket.once('close', () => {
        this.sockets.delete(socket);
      });
    });
  }

  /**
   * Run stoppers, stop accepting new connections, and wait up to `timeoutMs`
   * for in-flight connections to finish. If they do not, every tracked socket
   * is destroyed and the result is `'forced'`. Calling twice returns the same
   * in-flight/settled promise and never throws.
   */
  async shutdown(): Promise<ShutdownResult> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.runShutdown();
    return this.shutdownPromise;
  }

  private async runShutdown(): Promise<ShutdownResult> {
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const stoppers = this.opts.stoppers ?? [];

    // 1. Run every stopper; a throwing stopper must not abort the others.
    for (const stopper of stoppers) {
      try {
        await stopper();
      } catch {
        // Intentionally swallowed: one failing stopper cannot block shutdown.
      }
    }

    // 2 & 3. Close the server and race it against the timeout.
    return new Promise<ShutdownResult>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;

      const finish = (result: ShutdownResult): void => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        resolve(result);
      };

      this.server.close(() => finish('clean'));

      timer = setTimeout(() => {
        for (const socket of this.sockets) {
          socket.destroy();
        }
        finish('forced');
      }, timeoutMs);
      // Do not keep the event loop alive solely for the force timer.
      if (typeof timer.unref === 'function') timer.unref();
    });
  }
}
