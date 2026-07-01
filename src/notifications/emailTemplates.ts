import { Currency } from '../domain/types';
import { fromMinorUnits } from '../core/money';

/** Supported email locales. Falls back to English for unknown locales. */
export type Locale = 'zh-CN' | 'en';
export const SUPPORTED_LOCALES: Locale[] = ['zh-CN', 'en'];

export type EmailType =
  | 'payment_receipt'
  | 'refund_notice'
  | 'expiry_reminder'
  | 'expired_notice';

export interface EmailData {
  userName?: string;
  planName: string;
  /** Amount in minor units (for receipt / refund). */
  amountMinor?: number;
  currency?: Currency;
  /** ISO date string for expiry-related emails. */
  expiryDate?: string;
  /** Order / refund reference to show. */
  reference?: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function normaliseLocale(locale: string): Locale {
  return SUPPORTED_LOCALES.includes(locale as Locale) ? (locale as Locale) : 'en';
}

function money(data: EmailData): string {
  if (data.amountMinor === undefined || !data.currency) return '';
  return `${fromMinorUnits(data.amountMinor, data.currency)} ${data.currency}`;
}

/** Minimal HTML escaping for interpolated values. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

type Builder = (d: EmailData) => { subject: string; lines: string[] };

const TEMPLATES: Record<Locale, Record<EmailType, Builder>> = {
  'zh-CN': {
    payment_receipt: (d) => ({
      subject: `支付成功：${d.planName}`,
      lines: [
        `${d.userName ? d.userName + '，' : ''}您好：`,
        `我们已收到您的付款，感谢您购买 VPN 服务。`,
        `套餐：${d.planName}`,
        `金额：${money(d)}`,
        d.reference ? `订单号：${d.reference}` : '',
        `您的服务已开通，祝您使用愉快。`,
      ],
    }),
    refund_notice: (d) => ({
      subject: `退款通知：${d.planName}`,
      lines: [
        `${d.userName ? d.userName + '，' : ''}您好：`,
        `您的退款已处理。`,
        `套餐：${d.planName}`,
        `退款金额：${money(d)}`,
        d.reference ? `退款单号：${d.reference}` : '',
        `款项将按原路退回，请留意到账。`,
      ],
    }),
    expiry_reminder: (d) => ({
      subject: `续费提醒：${d.planName} 即将到期`,
      lines: [
        `${d.userName ? d.userName + '，' : ''}您好：`,
        `您的 VPN 订阅即将到期。`,
        `套餐：${d.planName}`,
        d.expiryDate ? `到期时间：${d.expiryDate}` : '',
        `请及时续费，以免服务中断。`,
      ],
    }),
    expired_notice: (d) => ({
      subject: `服务已到期：${d.planName}`,
      lines: [
        `${d.userName ? d.userName + '，' : ''}您好：`,
        `您的 VPN 订阅已到期，服务已暂停。`,
        `套餐：${d.planName}`,
        `续费后即可立即恢复使用，欢迎回来。`,
      ],
    }),
  },
  en: {
    payment_receipt: (d) => ({
      subject: `Payment received: ${d.planName}`,
      lines: [
        `${d.userName ? 'Hi ' + d.userName + ',' : 'Hello,'}`,
        `Thank you for your purchase. Your payment has been received.`,
        `Plan: ${d.planName}`,
        `Amount: ${money(d)}`,
        d.reference ? `Order: ${d.reference}` : '',
        `Your service is now active. Enjoy!`,
      ],
    }),
    refund_notice: (d) => ({
      subject: `Refund processed: ${d.planName}`,
      lines: [
        `${d.userName ? 'Hi ' + d.userName + ',' : 'Hello,'}`,
        `Your refund has been processed.`,
        `Plan: ${d.planName}`,
        `Refund amount: ${money(d)}`,
        d.reference ? `Refund ref: ${d.reference}` : '',
        `The amount will be returned to your original payment method.`,
      ],
    }),
    expiry_reminder: (d) => ({
      subject: `Renewal reminder: ${d.planName} is expiring soon`,
      lines: [
        `${d.userName ? 'Hi ' + d.userName + ',' : 'Hello,'}`,
        `Your VPN subscription is about to expire.`,
        `Plan: ${d.planName}`,
        d.expiryDate ? `Expires: ${d.expiryDate}` : '',
        `Please renew in time to avoid any interruption.`,
      ],
    }),
    expired_notice: (d) => ({
      subject: `Subscription expired: ${d.planName}`,
      lines: [
        `${d.userName ? 'Hi ' + d.userName + ',' : 'Hello,'}`,
        `Your VPN subscription has expired and service is now paused.`,
        `Plan: ${d.planName}`,
        `Renew any time to restore access instantly. Welcome back!`,
      ],
    }),
  },
};

/** Render a billing email in the requested locale (falls back to English). */
export function renderEmail(type: EmailType, locale: string, data: EmailData): RenderedEmail {
  const loc = normaliseLocale(locale);
  const { subject, lines } = TEMPLATES[loc][type](data);
  const body = lines.filter((l) => l.trim() !== '');
  const text = body.join('\n');
  const html = `<div>${body.map((l) => `<p>${esc(l)}</p>`).join('')}</div>`;
  return { subject, text, html };
}
