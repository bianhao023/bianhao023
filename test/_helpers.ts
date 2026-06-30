import { generateKeyPairSync, createCipheriv } from 'node:crypto';
import {
  CallbackResult,
  CreatePaymentResult,
  Order,
  PaymentMethod,
  QueryResult,
} from '../src/domain/types';
import { PaymentProvider, RawCallback, HttpClient } from '../src/providers/provider';
import { SignatureError } from '../src/domain/errors';
import { RefundCallbackResult, RefundRequest, RefundResult, RefundStatus } from '../src/domain/refund';
import { TronChainClient, Trc20Transfer } from '../src/providers/usdt/usdtTron';

/** Generate an RSA-2048 keypair (PEM) for signing tests. */
export function genRsaKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privateKey, publicKey };
}

/** AES-256-GCM encrypt, returning base64(ciphertext || authTag) as WeChat does. */
export function aesGcmEncrypt(
  apiV3Key: string,
  nonce: string,
  associatedData: string,
  plaintext: string,
): string {
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(apiV3Key, 'utf8'), Buffer.from(nonce, 'utf8'));
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([enc, tag]).toString('base64');
}

/**
 * A scriptable fake provider for service/API tests. Its verifyCallback simply
 * parses the raw body as a CallbackResult, so tests can drive any scenario.
 */
export class FakeProvider implements PaymentProvider {
  signatureValid = true;
  queryResults = new Map<string, QueryResult>();

  constructor(readonly method: PaymentMethod) {}

  async createPayment(order: Order): Promise<CreatePaymentResult> {
    return {
      method: this.method,
      payTarget: `pay://${this.method}/${order.outTradeNo}`,
      renderAs: this.method === 'usdt' ? 'address' : 'qrcode',
      extra: {},
    };
  }

  async verifyCallback(cb: RawCallback): Promise<CallbackResult> {
    if (!this.signatureValid) throw new SignatureError('fake bad signature');
    return JSON.parse(cb.rawBody) as CallbackResult;
  }

  async queryPayment(order: Order): Promise<QueryResult> {
    return this.queryResults.get(order.id) ?? { paid: false, rawStatus: 'PENDING' };
  }

  callbackAck(success: boolean): { status: number; contentType: string; body: string } {
    return { status: success ? 200 : 500, contentType: 'text/plain', body: success ? 'ok' : 'fail' };
  }

  refundResult: RefundResult = { providerRefundId: 'rfd_1', status: RefundStatus.SUCCESS, rawStatus: 'OK' };
  lastRefundRequest?: RefundRequest;

  async refund(_order: Order, req: RefundRequest): Promise<RefundResult> {
    this.lastRefundRequest = req;
    return this.refundResult;
  }

  async verifyRefundCallback(cb: RawCallback): Promise<RefundCallbackResult> {
    if (!this.signatureValid) throw new SignatureError('fake bad refund signature');
    return JSON.parse(cb.rawBody) as RefundCallbackResult;
  }
}

/** Programmable HttpClient that returns queued responses and records requests. */
export class MockHttpClient implements HttpClient {
  requests: Array<{ method: string; url: string; headers?: Record<string, string>; body?: string }> = [];
  private responder: (req: { method: string; url: string; body?: string }) => { status: number; body: string };

  constructor(responder: (req: { method: string; url: string; body?: string }) => { status: number; body: string }) {
    this.responder = responder;
  }

  async request(opts: {
    method: 'GET' | 'POST';
    url: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{ status: number; body: string }> {
    this.requests.push(opts);
    return this.responder(opts);
  }
}

/** A controllable in-memory chain client for USDT tests. */
export class FakeChainClient implements TronChainClient {
  transfers: Trc20Transfer[] = [];
  async getIncomingTransfers(
    _address: string,
    _contract: string,
    sinceMs: number,
  ): Promise<Trc20Transfer[]> {
    return this.transfers.filter((t) => t.timestampMs >= sinceMs);
  }
}

/** Build a minimal CallbackResult for FakeProvider-driven tests. */
export function callbackBody(over: Partial<CallbackResult> & { outTradeNo: string }): string {
  const full: CallbackResult = {
    providerTxnId: `txn_${Math.random().toString(16).slice(2)}`,
    paid: true,
    paidAmount: 1500,
    currency: 'CNY',
    eventId: `evt_${Math.random().toString(16).slice(2)}`,
    rawStatus: 'SUCCESS',
    ...over,
  };
  return JSON.stringify(full);
}

/** Build a RefundCallbackResult body for FakeProvider-driven tests. */
export function refundCallbackBody(
  over: Partial<RefundCallbackResult> & { outRefundNo: string; status: RefundStatus.SUCCESS | RefundStatus.FAILED },
): string {
  const full: RefundCallbackResult = {
    outTradeNo: 'VPN1',
    providerRefundId: `prf_${Math.random().toString(16).slice(2)}`,
    eventId: `rfevt_${Math.random().toString(16).slice(2)}`,
    rawStatus: over.status === RefundStatus.SUCCESS ? 'SUCCESS' : 'CLOSED',
    ...over,
  };
  return JSON.stringify(full);
}
