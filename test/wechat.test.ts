import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WechatConfig } from '../src/config';
import { WechatPayProvider } from '../src/providers/wechat/wechatPay';
import { verifyNotificationSignature, buildAuthorizationHeader } from '../src/providers/wechat/sign';
import { aesGcmDecrypt, rsaSignSha256 } from '../src/utils/crypto';
import { Order, OrderStatus } from '../src/domain/types';
import { SignatureError } from '../src/domain/errors';
import { genRsaKeyPair, aesGcmEncrypt, MockHttpClient } from './_helpers';

const merchant = genRsaKeyPair();
const platform = genRsaKeyPair();
const API_V3_KEY = '0123456789abcdef0123456789abcdef'; // 32 chars

function cfg(): WechatConfig {
  return {
    appId: 'wxapp', mchId: '160000', privateKeyPem: merchant.privateKey, serialNo: 'SERIAL1',
    apiV3Key: API_V3_KEY, platformPublicKeyPem: platform.publicKey,
    notifyUrl: 'https://vpn.example/api/notify/wechat', apiBase: 'https://api.mch.weixin.qq.com',
  };
}

function order(): Order {
  const now = Date.now();
  return {
    id: 'o1', outTradeNo: 'VPN123', userId: 'u1', planId: 'monthly', method: 'wechat',
    currency: 'CNY', amount: 1500, status: OrderStatus.PENDING, createdAt: now,
    updatedAt: now, expiresAt: now + 900_000, metadata: {},
  };
}

test('authorization header has the expected WeChat v3 shape', () => {
  const header = buildAuthorizationHeader({
    method: 'POST', urlPath: '/v3/pay/transactions/native', body: '{}',
    mchId: '160000', serialNo: 'SERIAL1', privateKeyPem: merchant.privateKey,
  });
  assert.match(header, /^WECHATPAY2-SHA256-RSA2048 /);
  for (const field of ['mchid', 'nonce_str', 'signature', 'timestamp', 'serial_no']) {
    assert.match(header, new RegExp(`${field}="[^"]+"`));
  }
});

test('notification signature verify accepts good and rejects tampered', () => {
  const ts = '1700000000';
  const nonce = 'abc';
  const body = '{"hello":"world"}';
  const sig = rsaSignSha256(`${ts}\n${nonce}\n${body}\n`, platform.privateKey);

  assert.ok(verifyNotificationSignature({
    timestamp: ts, nonce, body, signatureB64: sig, platformPublicKeyPem: platform.publicKey,
  }));
  assert.ok(!verifyNotificationSignature({
    timestamp: ts, nonce, body: body + 'x', signatureB64: sig, platformPublicKeyPem: platform.publicKey,
  }));
});

test('AES-256-GCM encrypt/decrypt round-trips', () => {
  const nonce = 'abcdefghijkl'; // 12 chars
  const aad = 'transaction';
  const plaintext = '{"trade_state":"SUCCESS"}';
  const ct = aesGcmEncrypt(API_V3_KEY, nonce, aad, plaintext);
  assert.equal(aesGcmDecrypt(API_V3_KEY, nonce, aad, ct), plaintext);
});

test('createPayment signs the request and returns the QR code_url', async () => {
  const http = new MockHttpClient(() => ({
    status: 200, body: JSON.stringify({ code_url: 'weixin://wxpay/bizpayurl?pr=abc' }),
  }));
  const provider = new WechatPayProvider(cfg(), http);
  const res = await provider.createPayment(order());

  assert.equal(res.renderAs, 'qrcode');
  assert.equal(res.payTarget, 'weixin://wxpay/bizpayurl?pr=abc');
  assert.match(http.requests[0].headers!['Authorization'], /WECHATPAY2-SHA256-RSA2048/);
  const sentBody = JSON.parse(http.requests[0].body!);
  assert.equal(sentBody.amount.total, 1500);
  assert.equal(sentBody.out_trade_no, 'VPN123');
});

function buildNotification(now: number, overrides: Record<string, unknown> = {}) {
  const resourcePlain = JSON.stringify({
    out_trade_no: 'VPN123', transaction_id: 'wx_txn_1', trade_state: 'SUCCESS',
    amount: { total: 1500, payer_total: 1500 }, ...overrides,
  });
  const rNonce = 'abcdefghijkl';
  const aad = 'transaction';
  const ciphertext = aesGcmEncrypt(API_V3_KEY, rNonce, aad, resourcePlain);
  const envelope = { id: 'evt-1', resource: { ciphertext, nonce: rNonce, associated_data: aad } };
  const body = JSON.stringify(envelope);
  const ts = String(Math.floor(now / 1000));
  const hNonce = 'header-nonce';
  const signature = rsaSignSha256(`${ts}\n${hNonce}\n${body}\n`, platform.privateKey);
  return {
    rawBody: body,
    headers: {
      'wechatpay-timestamp': ts, 'wechatpay-nonce': hNonce, 'wechatpay-signature': signature,
    },
  };
}

test('verifyCallback decrypts and normalises a valid notification', async () => {
  const now = Date.now();
  const provider = new WechatPayProvider(cfg(), new MockHttpClient(() => ({ status: 200, body: '{}' })), () => now);
  const result = await provider.verifyCallback(buildNotification(now));

  assert.equal(result.paid, true);
  assert.equal(result.outTradeNo, 'VPN123');
  assert.equal(result.providerTxnId, 'wx_txn_1');
  assert.equal(result.paidAmount, 1500);
  assert.equal(result.eventId, 'evt-1');
});

test('verifyCallback rejects a bad signature', async () => {
  const now = Date.now();
  const provider = new WechatPayProvider(cfg(), new MockHttpClient(() => ({ status: 200, body: '{}' })), () => now);
  const n = buildNotification(now);
  n.headers['wechatpay-signature'] = rsaSignSha256('forged', genRsaKeyPair().privateKey);
  await assert.rejects(() => provider.verifyCallback(n), SignatureError);
});

test('verifyCallback accepts the "next" platform cert during rotation', async () => {
  const now = Date.now();
  // Primary key is WRONG; the correct platform key is configured as "next".
  const rotatingCfg = { ...cfg(), platformPublicKeyPem: genRsaKeyPair().publicKey, platformPublicKeyNext: platform.publicKey };
  const provider = new WechatPayProvider(rotatingCfg, new MockHttpClient(() => ({ status: 200, body: '{}' })), () => now);
  const result = await provider.verifyCallback(buildNotification(now));
  assert.equal(result.paid, true);
});

test('verifyCallback rejects when neither current nor next cert matches', async () => {
  const now = Date.now();
  const badCfg = { ...cfg(), platformPublicKeyPem: genRsaKeyPair().publicKey, platformPublicKeyNext: genRsaKeyPair().publicKey };
  const provider = new WechatPayProvider(badCfg, new MockHttpClient(() => ({ status: 200, body: '{}' })), () => now);
  await assert.rejects(() => provider.verifyCallback(buildNotification(now)), SignatureError);
});

test('verifyCallback rejects a stale (replayed) timestamp', async () => {
  const now = Date.now();
  const n = buildNotification(now - 10 * 60_000); // 10 minutes old
  const provider = new WechatPayProvider(cfg(), new MockHttpClient(() => ({ status: 200, body: '{}' })), () => now);
  await assert.rejects(() => provider.verifyCallback(n), SignatureError);
});

function buildRefundNotification(now: number, refundStatus: string) {
  const resourcePlain = JSON.stringify({
    out_trade_no: 'VPN123', out_refund_no: 'RF123', refund_id: 'wx_refund_1', refund_status: refundStatus,
  });
  const rNonce = 'abcdefghijkl';
  const aad = 'refund';
  const ciphertext = aesGcmEncrypt(API_V3_KEY, rNonce, aad, resourcePlain);
  const envelope = { id: 'rf-evt-1', resource: { ciphertext, nonce: rNonce, associated_data: aad } };
  const body = JSON.stringify(envelope);
  const ts = String(Math.floor(now / 1000));
  const hNonce = 'header-nonce';
  const signature = rsaSignSha256(`${ts}\n${hNonce}\n${body}\n`, platform.privateKey);
  return { rawBody: body, headers: { 'wechatpay-timestamp': ts, 'wechatpay-nonce': hNonce, 'wechatpay-signature': signature } };
}

test('verifyRefundCallback maps SUCCESS and CLOSED refund notifications', async () => {
  const now = Date.now();
  const provider = new WechatPayProvider(cfg(), new MockHttpClient(() => ({ status: 200, body: '{}' })), () => now);

  const ok = await provider.verifyRefundCallback(buildRefundNotification(now, 'SUCCESS'));
  assert.equal(ok.status, 'SUCCESS');
  assert.equal(ok.outRefundNo, 'RF123');
  assert.equal(ok.providerRefundId, 'wx_refund_1');
  assert.equal(ok.eventId, 'rf-evt-1');

  const closed = await provider.verifyRefundCallback(buildRefundNotification(now, 'CLOSED'));
  assert.equal(closed.status, 'FAILED');
});

test('verifyRefundCallback rejects a bad signature', async () => {
  const now = Date.now();
  const provider = new WechatPayProvider(cfg(), new MockHttpClient(() => ({ status: 200, body: '{}' })), () => now);
  const n = buildRefundNotification(now, 'SUCCESS');
  n.headers['wechatpay-signature'] = rsaSignSha256('forged', genRsaKeyPair().privateKey);
  await assert.rejects(() => provider.verifyRefundCallback(n), SignatureError);
});
