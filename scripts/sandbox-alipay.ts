/**
 * Alipay sandbox check: creates a real precreate order against the configured
 * Alipay gateway and prints the returned QR code payload.
 *
 * Point ALIPAY_GATEWAY at the sandbox gateway
 * (https://openapi.alipaydev.com/gateway.do) and provide sandbox credentials:
 *
 *   ALIPAY_APP_ID=... ALIPAY_PRIVATE_KEY=... ALIPAY_PUBLIC_KEY=... \
 *   ALIPAY_GATEWAY=https://openapi.alipaydev.com/gateway.do \
 *   npm run sandbox:alipay
 */
import { loadConfig } from '../src/config';
import { FetchHttpClient } from '../src/providers/provider';
import { AlipayProvider } from '../src/providers/alipay/alipay';
import { Order, OrderStatus } from '../src/domain/types';
import { newOutTradeNo, uuid } from '../src/utils/ids';

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.alipay) {
    console.error('Alipay is not configured. Set ALIPAY_APP_ID and ALIPAY_PRIVATE_KEY (and ALIPAY_PUBLIC_KEY).');
    process.exit(1);
  }
  const provider = new AlipayProvider(cfg.alipay, new FetchHttpClient());
  const now = Date.now();
  const order: Order = {
    id: uuid(), outTradeNo: newOutTradeNo('SANDBOX'), userId: 'sandbox', planId: 'monthly',
    method: 'alipay', currency: 'CNY', amount: 1, // 0.01 CNY
    status: OrderStatus.PENDING, createdAt: now, updatedAt: now, expiresAt: now + 900_000, metadata: {},
  };

  console.log(`Creating Alipay precreate order ${order.outTradeNo} (0.01 CNY) on ${cfg.alipay.gateway} ...`);
  const res = await provider.createPayment(order);
  console.log('QR payload:', res.payTarget);
  console.log('Render this as a QR code and scan it with the Alipay sandbox app.');
}

main().catch((err) => {
  console.error('sandbox-alipay failed:', err.message);
  process.exit(1);
});
