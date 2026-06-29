import { WechatConfig } from '../../config';
import {
  CallbackResult,
  CreatePaymentResult,
  Order,
  QueryResult,
} from '../../domain/types';
import { ProviderError, SignatureError } from '../../domain/errors';
import { HttpClient, PaymentProvider, RawCallback } from '../provider';
import { aesGcmDecrypt } from '../../utils/crypto';
import { buildAuthorizationHeader, verifyNotificationSignature } from './sign';
import { logger } from '../../utils/logger';

const NATIVE_PATH = '/v3/pay/transactions/native';
/** Reject notifications whose timestamp is older than this (replay defence). */
const MAX_CLOCK_SKEW_SECONDS = 300;

/** WeChat Pay v3 — Native (scan-to-pay QR) provider. */
export class WechatPayProvider implements PaymentProvider {
  readonly method = 'wechat' as const;

  constructor(
    private readonly cfg: WechatConfig,
    private readonly http: HttpClient,
    private readonly now: () => number = Date.now,
  ) {}

  async createPayment(order: Order): Promise<CreatePaymentResult> {
    const body = JSON.stringify({
      appid: this.cfg.appId,
      mchid: this.cfg.mchId,
      description: `VPN plan ${order.planId}`,
      out_trade_no: order.outTradeNo,
      notify_url: this.cfg.notifyUrl,
      amount: { total: order.amount, currency: 'CNY' },
      time_expire: new Date(order.expiresAt).toISOString(),
    });

    const auth = buildAuthorizationHeader({
      method: 'POST',
      urlPath: NATIVE_PATH,
      body,
      mchId: this.cfg.mchId,
      serialNo: this.cfg.serialNo,
      privateKeyPem: this.cfg.privateKeyPem,
    });

    const res = await this.http.request({
      method: 'POST',
      url: `${this.cfg.apiBase}${NATIVE_PATH}`,
      headers: {
        Authorization: auth,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'vpn-payment-backend/1.0',
      },
      body,
    });

    if (res.status !== 200) {
      logger.error('wechat create failed', { status: res.status, body: res.body });
      throw new ProviderError(`wechat create payment failed (${res.status})`);
    }
    const parsed = JSON.parse(res.body) as { code_url?: string };
    if (!parsed.code_url) throw new ProviderError('wechat returned no code_url');

    return {
      method: this.method,
      payTarget: parsed.code_url,
      renderAs: 'qrcode',
      extra: { currency: 'CNY' },
    };
  }

  async verifyCallback(cb: RawCallback): Promise<CallbackResult> {
    const timestamp = cb.headers['wechatpay-timestamp'];
    const nonce = cb.headers['wechatpay-nonce'];
    const signature = cb.headers['wechatpay-signature'];
    if (!timestamp || !nonce || !signature) {
      throw new SignatureError('missing WeChat signature headers');
    }

    // Replay defence: reject stale notifications.
    const skew = Math.abs(this.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(skew) || skew > MAX_CLOCK_SKEW_SECONDS) {
      throw new SignatureError('WeChat notification timestamp out of range');
    }

    const ok = verifyNotificationSignature({
      timestamp,
      nonce,
      body: cb.rawBody,
      signatureB64: signature,
      platformPublicKeyPem: this.cfg.platformPublicKeyPem,
    });
    if (!ok) throw new SignatureError('WeChat notification signature invalid');

    const envelope = JSON.parse(cb.rawBody) as {
      id: string;
      resource: { ciphertext: string; nonce: string; associated_data: string };
    };

    const plaintext = aesGcmDecrypt(
      this.cfg.apiV3Key,
      envelope.resource.nonce,
      envelope.resource.associated_data,
      envelope.resource.ciphertext,
    );
    const data = JSON.parse(plaintext) as {
      out_trade_no: string;
      transaction_id: string;
      trade_state: string;
      amount: { total: number; payer_total: number };
    };

    return {
      outTradeNo: data.out_trade_no,
      providerTxnId: data.transaction_id,
      paid: data.trade_state === 'SUCCESS',
      paidAmount: data.amount.payer_total ?? data.amount.total,
      currency: 'CNY',
      eventId: envelope.id,
      rawStatus: data.trade_state,
    };
  }

  async queryPayment(order: Order): Promise<QueryResult> {
    const path = `/v3/pay/transactions/out-trade-no/${order.outTradeNo}?mchid=${this.cfg.mchId}`;
    const auth = buildAuthorizationHeader({
      method: 'GET',
      urlPath: path,
      body: '',
      mchId: this.cfg.mchId,
      serialNo: this.cfg.serialNo,
      privateKeyPem: this.cfg.privateKeyPem,
    });
    const res = await this.http.request({
      method: 'GET',
      url: `${this.cfg.apiBase}${path}`,
      headers: { Authorization: auth, Accept: 'application/json' },
    });
    if (res.status !== 200) throw new ProviderError(`wechat query failed (${res.status})`);
    const data = JSON.parse(res.body) as {
      transaction_id?: string;
      trade_state: string;
      amount?: { payer_total?: number; total?: number };
    };
    return {
      paid: data.trade_state === 'SUCCESS',
      providerTxnId: data.transaction_id,
      paidAmount: data.amount?.payer_total ?? data.amount?.total,
      rawStatus: data.trade_state,
    };
  }

  callbackAck(success: boolean): { status: number; contentType: string; body: string } {
    if (success) return { status: 200, contentType: 'application/json', body: '{"code":"SUCCESS","message":"OK"}' };
    return { status: 500, contentType: 'application/json', body: '{"code":"FAIL","message":"FAILED"}' };
  }
}
