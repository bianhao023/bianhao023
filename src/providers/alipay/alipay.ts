import { AlipayConfig } from '../../config';
import {
  CallbackResult,
  CreatePaymentResult,
  Order,
  QueryResult,
} from '../../domain/types';
import { ProviderError, SignatureError } from '../../domain/errors';
import { HttpClient, PaymentProvider, RawCallback } from '../provider';
import { fromMinorUnits, toMinorUnits } from '../../core/money';
import { signParams, verifyParams } from './sign';
import { logger } from '../../utils/logger';

/** Alipay — trade.precreate (merchant-presented QR) provider. */
export class AlipayProvider implements PaymentProvider {
  readonly method = 'alipay' as const;

  constructor(
    private readonly cfg: AlipayConfig,
    private readonly http: HttpClient,
  ) {}

  private commonParams(method: string, bizContent: object): Record<string, string> {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const timestamp =
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    return {
      app_id: this.cfg.appId,
      method,
      format: 'JSON',
      charset: 'utf-8',
      sign_type: this.cfg.signType,
      timestamp,
      version: '1.0',
      notify_url: this.cfg.notifyUrl,
      biz_content: JSON.stringify(bizContent),
    };
  }

  async createPayment(order: Order): Promise<CreatePaymentResult> {
    const params = this.commonParams('alipay.trade.precreate', {
      out_trade_no: order.outTradeNo,
      total_amount: fromMinorUnits(order.amount, 'CNY'),
      subject: `VPN plan ${order.planId}`,
    });
    params['sign'] = signParams(params, this.cfg.privateKeyPem);

    const form = new URLSearchParams(params).toString();
    const res = await this.http.request({
      method: 'POST',
      url: this.cfg.gateway,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: form,
    });
    if (res.status !== 200) throw new ProviderError(`alipay precreate failed (${res.status})`);

    const parsed = JSON.parse(res.body) as {
      alipay_trade_precreate_response?: { code: string; msg: string; qr_code?: string };
    };
    const r = parsed.alipay_trade_precreate_response;
    if (!r || r.code !== '10000' || !r.qr_code) {
      logger.error('alipay precreate rejected', { resp: r });
      throw new ProviderError(`alipay precreate rejected: ${r?.msg ?? 'unknown'}`);
    }
    return {
      method: this.method,
      payTarget: r.qr_code,
      renderAs: 'qrcode',
      extra: { currency: 'CNY' },
    };
  }

  async verifyCallback(cb: RawCallback): Promise<CallbackResult> {
    const params: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(cb.rawBody)) params[k] = v;

    if (!verifyParams(params, this.cfg.alipayPublicKeyPem)) {
      throw new SignatureError('alipay notification signature invalid');
    }
    // Defence in depth: the notification must be addressed to our app.
    if (params['app_id'] && params['app_id'] !== this.cfg.appId) {
      throw new SignatureError('alipay app_id mismatch');
    }

    const status = params['trade_status'] ?? '';
    const paid = status === 'TRADE_SUCCESS' || status === 'TRADE_FINISHED';
    return {
      outTradeNo: params['out_trade_no'],
      providerTxnId: params['trade_no'],
      paid,
      paidAmount: params['total_amount'] ? toMinorUnits(params['total_amount'], 'CNY') : 0,
      currency: 'CNY',
      // notify_id is unique per notification; fall back to trade_no for dedupe.
      eventId: params['notify_id'] || `${params['trade_no']}:${status}`,
      rawStatus: status,
    };
  }

  async queryPayment(order: Order): Promise<QueryResult> {
    const params = this.commonParams('alipay.trade.query', {
      out_trade_no: order.outTradeNo,
    });
    params['sign'] = signParams(params, this.cfg.privateKeyPem);
    const res = await this.http.request({
      method: 'POST',
      url: this.cfg.gateway,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: new URLSearchParams(params).toString(),
    });
    if (res.status !== 200) throw new ProviderError(`alipay query failed (${res.status})`);
    const parsed = JSON.parse(res.body) as {
      alipay_trade_query_response?: {
        trade_status?: string;
        trade_no?: string;
        total_amount?: string;
      };
    };
    const r = parsed.alipay_trade_query_response ?? {};
    const status = r.trade_status ?? '';
    return {
      paid: status === 'TRADE_SUCCESS' || status === 'TRADE_FINISHED',
      providerTxnId: r.trade_no,
      paidAmount: r.total_amount ? toMinorUnits(r.total_amount, 'CNY') : undefined,
      rawStatus: status,
    };
  }

  callbackAck(success: boolean): { status: number; contentType: string; body: string } {
    // Alipay expects the literal string "success" to stop retrying.
    return { status: 200, contentType: 'text/plain', body: success ? 'success' : 'failure' };
  }
}
