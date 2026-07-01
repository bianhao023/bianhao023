/**
 * WeChat Pay check: creates a real Native (scan-to-pay) order against the
 * configured WeChat Pay v3 API and prints the returned code_url.
 *
 *   WECHAT_APP_ID=... WECHAT_MCH_ID=... WECHAT_PRIVATE_KEY=... \
 *   WECHAT_SERIAL_NO=... WECHAT_API_V3_KEY=... WECHAT_NOTIFY_URL=... \
 *   npm run sandbox:wechat
 *
 * Note: WeChat Pay has no separate public sandbox; use a real merchant with a
 * tiny amount (1 fen) for verification.
 */
import { loadConfig } from '../src/config';
import { FetchHttpClient } from '../src/providers/provider';
import { WechatPayProvider } from '../src/providers/wechat/wechatPay';
import { Order, OrderStatus } from '../src/domain/types';
import { newOutTradeNo, uuid } from '../src/utils/ids';

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.wechat) {
    console.error('WeChat Pay is not configured. Set WECHAT_MCH_ID and WECHAT_PRIVATE_KEY (and related vars).');
    process.exit(1);
  }
  const provider = new WechatPayProvider(cfg.wechat, new FetchHttpClient());
  const now = Date.now();
  const order: Order = {
    id: uuid(), outTradeNo: newOutTradeNo('SANDBOX'), userId: 'sandbox', planId: 'monthly',
    method: 'wechat', currency: 'CNY', amount: 1, // 1 fen
    status: OrderStatus.PENDING, createdAt: now, updatedAt: now, expiresAt: now + 900_000, metadata: {},
  };

  console.log(`Creating WeChat Native order ${order.outTradeNo} (0.01 CNY) on ${cfg.wechat.apiBase} ...`);
  const res = await provider.createPayment(order);
  console.log('code_url:', res.payTarget);
  console.log('Render this as a QR code and scan it with WeChat.');
}

main().catch((err) => {
  console.error('sandbox-wechat failed:', err.message);
  process.exit(1);
});
