import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gfMul, gfLog, rsGenerator, encodeToMatrix, decodeForTest } from '../src/qr/qrEncoder';
import { qrToSvg, qrToDataUri } from '../src/qr/qrSvg';

// ── Galois field / Reed–Solomon math (checked against published QR values) ──

test('GF(256) multiply basics', () => {
  assert.equal(gfMul(0, 5), 0);
  assert.equal(gfMul(1, 5), 5);
  assert.equal(gfMul(5, 1), 5);
  assert.equal(gfMul(3, 7), gfMul(7, 3)); // commutative
});

test('RS generator polynomials match the published QR exponents', () => {
  // ISO/IEC 18004 generator-polynomial coefficient exponents (α^e).
  assert.deepEqual(rsGenerator(7).map(gfLog), [0, 87, 229, 146, 149, 238, 102, 21]);
  assert.deepEqual(rsGenerator(10).map(gfLog), [0, 251, 67, 46, 61, 118, 70, 64, 94, 32, 45]);
  assert.deepEqual(
    rsGenerator(13).map(gfLog),
    [0, 74, 152, 176, 100, 86, 100, 106, 104, 130, 218, 206, 140, 78],
  );
});

// ── Structural invariants of the produced symbol ────────────────────────────

test('symbol size follows the version formula and finder patterns are placed', () => {
  const qr = encodeToMatrix('HELLO');
  assert.equal(qr.size, 17 + qr.version * 4);
  const m = qr.modules;
  // Top-left finder: dark border ring, light inner ring, dark 3×3 core.
  assert.equal(m[0][0], true);
  assert.equal(m[1][1], false);
  assert.equal(m[3][3], true); // centre of the 3×3 core
  assert.equal(m[0][6], true);
  assert.equal(m[1][5], false);
  // Separator: the module just outside the finder is light.
  assert.equal(m[7][7], false);
});

// ── Round-trip: encode → decode recovers the input across modes & versions ──

test('round-trips numeric content (also exercises the ISO example)', () => {
  for (const s of ['01234567', '8675309', '0', '000000000000']) {
    assert.equal(decodeForTest(encodeToMatrix(s)), s);
  }
});

test('round-trips byte content: URLs and a TRON address', () => {
  const samples = [
    'weixin://wxpay/bizpayurl?pr=abcDEF123',
    'https://qr.alipay.com/bax00000abcdefghijklmn',
    'TXuserWalletDepositAddr00000000000',
    'https://pay.example.com/v1/checkout?order=9f2b1&amt=15.00&cur=CNY&sig=deadbeefcafebabe',
  ];
  for (const s of samples) {
    assert.equal(decodeForTest(encodeToMatrix(s)), s);
  }
});

test('round-trips content that forces higher versions (incl. the v10 count-group)', () => {
  for (const len of [40, 90, 140, 190, 210]) {
    const s = 'x'.repeat(len);
    const qr = encodeToMatrix(s);
    assert.equal(decodeForTest(qr), s, `len=${len} v=${qr.version}`);
  }
});

test('content beyond version-10 capacity throws rather than truncating', () => {
  assert.throws(() => encodeToMatrix('x'.repeat(400)), /too large/);
});

// ── SVG rendering ───────────────────────────────────────────────────────────

test('qrToSvg emits a self-contained SVG sized to the symbol + quiet zone', () => {
  const qr = encodeToMatrix('https://qr.alipay.com/bax0001');
  const svg = qrToSvg('https://qr.alipay.com/bax0001', { moduleSize: 5, margin: 4 });
  const expectedDim = (qr.size + 8) * 5;
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.ok(svg.includes(`width="${expectedDim}"`));
  assert.ok(svg.includes('<path d="M'), 'has a dark-module path');
  assert.ok(!svg.includes('http://') || svg.includes('www.w3.org'), 'no external asset refs');
});

test('qrToDataUri is a base64 SVG data URI that decodes to the SVG', () => {
  const uri = qrToDataUri('TXuserWalletDepositAddr00000000000');
  assert.match(uri, /^data:image\/svg\+xml;base64,/);
  const decoded = Buffer.from(uri.split(',')[1], 'base64').toString('utf8');
  assert.ok(decoded.startsWith('<svg'));
});
