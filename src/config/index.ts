import { PaymentMethod } from '../domain/types';

/** WeChat Pay v3 (Native) configuration. */
export interface WechatConfig {
  appId: string;
  mchId: string;
  /** Merchant API private key (PEM). */
  privateKeyPem: string;
  /** Merchant certificate serial number. */
  serialNo: string;
  /** APIv3 symmetric key (32 chars) used to decrypt notifications. */
  apiV3Key: string;
  /** WeChat platform public certificate (PEM) used to verify notifications. */
  platformPublicKeyPem: string;
  /** URL WeChat will POST notifications to. */
  notifyUrl: string;
  apiBase: string;
}

/** Alipay configuration. */
export interface AlipayConfig {
  appId: string;
  /** Merchant app private key (PEM, PKCS8). */
  privateKeyPem: string;
  /** Alipay public key (PEM) used to verify async notifications. */
  alipayPublicKeyPem: string;
  notifyUrl: string;
  gateway: string;
  signType: 'RSA2';
}

/** USDT (TRC20) configuration. */
export interface UsdtConfig {
  /** Receiving TRON address (shared, with per-order unique amounts). */
  receivingAddress: string;
  /** TRC20 contract address (defaults to the canonical USDT contract). */
  contractAddress: string;
  /** TronGrid (or compatible) API base. */
  apiBase: string;
  /** Optional API key header for TronGrid. */
  apiKey?: string;
  /** Confirmations required before treating a transfer as settled. */
  minConfirmations: number;
  /** Max micro-USDT delta added for uniqueness (e.g. 9999 -> up to 0.009999 USDT). */
  uniqueAmountMaxDelta: number;
}

/** Fixed-window rate limiting configuration. */
export interface RateLimitConfig {
  enabled: boolean;
  /** Max requests per window per client+route. */
  max: number;
  windowMs: number;
}

/** Outbound merchant webhook configuration. */
export interface WebhookConfig {
  /** Merchant endpoint that receives signed event notifications. */
  url: string;
  /** HMAC-SHA256 secret used to sign payloads. */
  secret: string;
  /** Max delivery attempts before a delivery is dead-lettered. */
  maxAttempts: number;
}

/** SMTP configuration for outbound billing emails. */
export interface SmtpConfig {
  host: string;
  port: number;
  /** true => connect over TLS directly (e.g. port 465). */
  secure: boolean;
  user?: string;
  pass?: string;
  /** Envelope + header From address. */
  from: string;
}

export interface AppConfig {
  port: number;
  /** Minutes a pending order stays payable before EXPIRED. */
  orderTtlMinutes: number;
  enabledMethods: PaymentMethod[];
  /** Bearer token guarding the /admin endpoints. When unset, admin is disabled. */
  adminToken?: string;
  /** Days before expiry to send a renewal reminder. */
  expiryReminderDays: number;
  rateLimit: RateLimitConfig;
  wechat?: WechatConfig;
  alipay?: AlipayConfig;
  usdt?: UsdtConfig;
  smtp?: SmtpConfig;
  webhook?: WebhookConfig;
}

const CANONICAL_USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

function env(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

/**
 * Build configuration from environment variables. A method is only enabled if
 * its mandatory variables are present, so the system can run with any subset
 * of payment methods configured.
 */
export function loadConfig(): AppConfig {
  const enabled: PaymentMethod[] = [];

  let wechat: WechatConfig | undefined;
  if (env('WECHAT_MCH_ID') && env('WECHAT_PRIVATE_KEY')) {
    wechat = {
      appId: env('WECHAT_APP_ID'),
      mchId: env('WECHAT_MCH_ID'),
      privateKeyPem: env('WECHAT_PRIVATE_KEY').replace(/\\n/g, '\n'),
      serialNo: env('WECHAT_SERIAL_NO'),
      apiV3Key: env('WECHAT_API_V3_KEY'),
      platformPublicKeyPem: env('WECHAT_PLATFORM_PUBLIC_KEY').replace(/\\n/g, '\n'),
      notifyUrl: env('WECHAT_NOTIFY_URL'),
      apiBase: env('WECHAT_API_BASE', 'https://api.mch.weixin.qq.com'),
    };
    enabled.push('wechat');
  }

  let alipay: AlipayConfig | undefined;
  if (env('ALIPAY_APP_ID') && env('ALIPAY_PRIVATE_KEY')) {
    alipay = {
      appId: env('ALIPAY_APP_ID'),
      privateKeyPem: env('ALIPAY_PRIVATE_KEY').replace(/\\n/g, '\n'),
      alipayPublicKeyPem: env('ALIPAY_PUBLIC_KEY').replace(/\\n/g, '\n'),
      notifyUrl: env('ALIPAY_NOTIFY_URL'),
      gateway: env('ALIPAY_GATEWAY', 'https://openapi.alipay.com/gateway.do'),
      signType: 'RSA2',
    };
    enabled.push('alipay');
  }

  let usdt: UsdtConfig | undefined;
  if (env('USDT_RECEIVING_ADDRESS')) {
    usdt = {
      receivingAddress: env('USDT_RECEIVING_ADDRESS'),
      contractAddress: env('USDT_CONTRACT_ADDRESS', CANONICAL_USDT_TRC20),
      apiBase: env('USDT_API_BASE', 'https://api.trongrid.io'),
      apiKey: env('USDT_API_KEY') || undefined,
      minConfirmations: Number(env('USDT_MIN_CONFIRMATIONS', '19')),
      uniqueAmountMaxDelta: Number(env('USDT_UNIQUE_DELTA_MAX', '9999')),
    };
    enabled.push('usdt');
  }

  let smtp: SmtpConfig | undefined;
  if (env('SMTP_HOST')) {
    smtp = {
      host: env('SMTP_HOST'),
      port: Number(env('SMTP_PORT', '587')),
      secure: env('SMTP_SECURE', 'false') === 'true',
      user: env('SMTP_USER') || undefined,
      pass: env('SMTP_PASS') || undefined,
      from: env('SMTP_FROM', 'no-reply@example.com'),
    };
  }

  let webhook: WebhookConfig | undefined;
  if (env('WEBHOOK_URL')) {
    webhook = {
      url: env('WEBHOOK_URL'),
      secret: env('WEBHOOK_SECRET'),
      maxAttempts: Number(env('WEBHOOK_MAX_ATTEMPTS', '6')),
    };
  }

  return {
    port: Number(env('PORT', '3000')),
    orderTtlMinutes: Number(env('ORDER_TTL_MINUTES', '15')),
    enabledMethods: enabled,
    adminToken: env('ADMIN_TOKEN') || undefined,
    expiryReminderDays: Number(env('EXPIRY_REMINDER_DAYS', '3')),
    rateLimit: {
      enabled: env('RATE_LIMIT_ENABLED', 'true') !== 'false',
      max: Number(env('RATE_LIMIT_MAX', '100')),
      windowMs: Number(env('RATE_LIMIT_WINDOW_SEC', '60')) * 1000,
    },
    wechat,
    alipay,
    usdt,
    smtp,
    webhook,
  };
}

export { CANONICAL_USDT_TRC20 };
