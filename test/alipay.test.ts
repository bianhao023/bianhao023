import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlipayConfig } from '../src/config';
import { AlipayProvider } from '../src/providers/alipay/alipay';
import { buildSignContent, signParams, verifyParams } from '../src/providers/alipay/sign';
import { Order, OrderStatus } from '../src/domain/types';
import { SignatureError } from '../src/domain/errors';
import { genRsaKeyPair, MockHttpClient } from './_helpers';

const merchant = genRsaKeyPair();
const alipay = genRsaKeyPair();

function cfg(): AlipayConfig {
  return {
    appId: '2021000000000000', privateKeyPem: merchant.privateKey,
    alipayPublicKeyPem: alipay.publicKey, notifyUrl: 'https://vpn.example/api/notify/alipay',
    gateway: 'https://openapi.alipay.com/gateway.do', signType: 'RSA2',
  };
}

function order(): Order {
  const now = Date.now();
  return {
    id: 'o1', outTradeNo: 'VPN999', userId: 'u1', planId: 'monthly', method: 'alipay',
    currency: 'CNY', amount: 1500, status: OrderStatus.PENDING, createdAt: now,
    updatedAt: now, expiresAt: now + 900_000, metadata: {},
  };
}

test('sign content excludes sign/sign_type/empty and is sorted', () => {
  const content = buildSignContent({ b: '2', a: '1', sign: 'x', sign_type: 'RSA2', empty: '' });
  assert.equal(content, 'a=1&b=2');
});

test('RSA2 sign and verify round-trip; tamper is detected', () => {
  const params: Record<string, string> = {
    out_trade_no: 'VPN999', trade_status: 'TRADE_SUCCESS', total_amount: '15.00', app_id: '2021000000000000',
  };
  params['sign'] = signParams(params, merchant.privateKey);
  // Verify with the SAME keypair's public key (here merchant acts as signer).
  assert.ok(verifyParams(params, merchant.publicKey));

  const tampered = { ...params, total_amount: '0.01' };
  assert.ok(!verifyParams(tampered, merchant.publicKey));
});

test('createPayment posts a signed precreate and returns the qr_code', async () => {
  const http = new MockHttpClient(() => ({
    status: 200,
    body: JSON.stringify({ alipay_trade_precreate_response: { code: '10000', msg: 'Success', qr_code: 'https://qr.alipay.com/abc' } }),
  }));
  const res = await new AlipayProvider(cfg(), http).createPayment(order());
  assert.equal(res.renderAs, 'qrcode');
  assert.equal(res.payTarget, 'https://qr.alipay.com/abc');

  const sent = new URLSearchParams(http.requests[0].body!);
  assert.equal(sent.get('method'), 'alipay.trade.precreate');
  assert.ok(sent.get('sign'));
  const biz = JSON.parse(sent.get('biz_content')!);
  assert.equal(biz.total_amount, '15.00');
});

test('createPayment surfaces a provider rejection', async () => {
  const http = new MockHttpClient(() => ({
    status: 200, body: JSON.stringify({ alipay_trade_precreate_response: { code: '40004', msg: 'Business Failed' } }),
  }));
  await assert.rejects(() => new AlipayProvider(cfg(), http).createPayment(order()), /rejected/);
});

test('verifyCallback validates a signed notification', async () => {
  const params: Record<string, string> = {
    app_id: '2021000000000000', out_trade_no: 'VPN999', trade_no: 'ali_txn_1',
    trade_status: 'TRADE_SUCCESS', total_amount: '15.00', notify_id: 'ntf_1',
  };
  // Alipay signs notifications with ITS private key -> we verify with alipay public key.
  params['sign'] = signParams(params, alipay.privateKey);
  const rawBody = new URLSearchParams(params).toString();

  const provider = new AlipayProvider(cfg(), new MockHttpClient(() => ({ status: 200, body: '{}' })));
  const result = await provider.verifyCallback({ rawBody, headers: {} });

  assert.equal(result.paid, true);
  assert.equal(result.outTradeNo, 'VPN999');
  assert.equal(result.providerTxnId, 'ali_txn_1');
  assert.equal(result.paidAmount, 1500);
  assert.equal(result.eventId, 'ntf_1');
});

test('verifyCallback rejects a forged notification', async () => {
  const params: Record<string, string> = {
    app_id: '2021000000000000', out_trade_no: 'VPN999', trade_no: 'ali_txn_1',
    trade_status: 'TRADE_SUCCESS', total_amount: '15.00', sign: 'forged',
  };
  const rawBody = new URLSearchParams(params).toString();
  const provider = new AlipayProvider(cfg(), new MockHttpClient(() => ({ status: 200, body: '{}' })));
  await assert.rejects(() => provider.verifyCallback({ rawBody, headers: {} }), SignatureError);
});
