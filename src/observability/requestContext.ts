import { AsyncLocalStorage } from 'node:async_hooks';

/** Per-request ambient state, propagated across async boundaries. */
export interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Run `fn` with the given request id bound to the async context, so any code it
 * calls (services, repositories, …) can be correlated in logs without threading
 * the id through every function signature.
 */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

/** The current request id if inside a `runWithRequestId` scope, else undefined. */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
