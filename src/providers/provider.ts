import {
  CallbackResult,
  CreatePaymentResult,
  Order,
  PaymentMethod,
  QueryResult,
} from '../domain/types';
import { RefundRequest, RefundResult } from '../domain/refund';

/** A raw inbound HTTP request as seen by a webhook handler. */
export interface RawCallback {
  /** Raw request body bytes, exactly as received (required for signatures). */
  rawBody: string;
  headers: Record<string, string>;
}

/**
 * Common interface every payment method implements. The PaymentService depends
 * only on this abstraction, so methods can be added without touching the core.
 */
export interface PaymentProvider {
  readonly method: PaymentMethod;

  /** Create a payment intent and return what the client must display. */
  createPayment(order: Order): Promise<CreatePaymentResult>;

  /**
   * Verify and normalise an inbound provider callback. MUST throw
   * SignatureError if authenticity cannot be proven. For USDT (no push
   * callback) this is unused; reconciliation uses the watcher instead.
   */
  verifyCallback(cb: RawCallback): Promise<CallbackResult>;

  /** Actively query the provider/chain for an order's current status. */
  queryPayment(order: Order): Promise<QueryResult>;

  /** The body a provider expects in the HTTP response to its callback (e.g. WeChat/Alipay ACK). */
  callbackAck(success: boolean): { status: number; contentType: string; body: string };

  /**
   * Issue a refund. Optional: methods without an automatic refund channel
   * (e.g. USDT) omit this, and the RefundService falls back to a manual refund.
   */
  refund?(order: Order, req: RefundRequest): Promise<RefundResult>;
}

/** Minimal injectable HTTP client so providers can be unit-tested with mocks. */
export interface HttpClient {
  request(opts: {
    method: 'GET' | 'POST';
    url: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{ status: number; body: string }>;
}

/** Default HttpClient backed by the global fetch (Node >= 18). */
export class FetchHttpClient implements HttpClient {
  async request(opts: {
    method: 'GET' | 'POST';
    url: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{ status: number; body: string }> {
    const res = await fetch(opts.url, {
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
    });
    const body = await res.text();
    return { status: res.status, body };
  }
}
