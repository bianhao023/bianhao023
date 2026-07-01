import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderEmail, EmailType, SUPPORTED_LOCALES } from '../src/notifications/emailTemplates';
import { TemplatedEmailNotifier, RecordingMailSender, UserContact } from '../src/notifications/emailNotifier';
import { PlanCatalog } from '../src/services/plans';

const TYPES: EmailType[] = ['payment_receipt', 'refund_notice', 'expiry_reminder', 'expired_notice'];

test('renders every type in every supported locale with a subject and body', () => {
  for (const locale of SUPPORTED_LOCALES) {
    for (const type of TYPES) {
      const email = renderEmail(type, locale, {
        userName: 'Alex', planName: 'Monthly', amountMinor: 1500, currency: 'CNY',
        expiryDate: '2026-07-15', reference: 'VPN123',
      });
      assert.ok(email.subject.length > 0, `${locale}/${type} subject`);
      assert.ok(email.text.length > 0, `${locale}/${type} text`);
      assert.match(email.html, /^<div>.*<\/div>$/s);
      assert.match(email.text, /Monthly/);
    }
  }
});

test('formats money and localises the receipt subject', () => {
  const zh = renderEmail('payment_receipt', 'zh-CN', { planName: '月付', amountMinor: 1500, currency: 'CNY' });
  assert.match(zh.subject, /支付成功/);
  assert.match(zh.text, /15\.00 CNY/);

  const en = renderEmail('payment_receipt', 'en', { planName: 'Monthly', amountMinor: 2_000_000, currency: 'USDT' });
  assert.match(en.subject, /Payment received/);
  assert.match(en.text, /2\.000000 USDT/);
});

test('unknown locale falls back to English', () => {
  const email = renderEmail('expiry_reminder', 'fr-FR', { planName: 'Yearly', expiryDate: '2026-07-01' });
  assert.match(email.subject, /Renewal reminder/);
});

test('HTML output escapes interpolated values', () => {
  const email = renderEmail('payment_receipt', 'en', { userName: '<script>', planName: 'A & B' });
  assert.ok(!email.html.includes('<script>'));
  assert.match(email.html, /&lt;script&gt;/);
  assert.match(email.html, /A &amp; B/);
});

test('TemplatedEmailNotifier maps expiry events to localized emails', async () => {
  const sender = new RecordingMailSender();
  const plans = new PlanCatalog();
  const contacts: Record<string, UserContact> = {
    u1: { email: 'u1@example.com', locale: 'zh-CN', name: '小明' },
    u2: { email: 'u2@example.com', locale: 'en' },
  };
  const notifier = new TemplatedEmailNotifier({
    sender, plans, users: async (id) => contacts[id],
  });

  await notifier.notify({
    type: 'subscription_expiring', userId: 'u1', subscriptionId: 's1',
    planId: 'monthly', expiresAt: Date.UTC(2026, 6, 15), at: Date.now(),
  });
  await notifier.notify({
    type: 'subscription_expired', userId: 'u2', subscriptionId: 's2',
    planId: 'yearly', expiresAt: Date.UTC(2026, 0, 1), at: Date.now(),
  });

  assert.equal(sender.sent.length, 2);
  assert.equal(sender.sent[0].to, 'u1@example.com');
  assert.match(sender.sent[0].subject, /续费提醒/);
  assert.match(sender.sent[0].text, /Monthly/);
  assert.match(sender.sent[1].subject, /Subscription expired/);
});

test('users without an email are skipped', async () => {
  const sender = new RecordingMailSender();
  const notifier = new TemplatedEmailNotifier({
    sender, plans: new PlanCatalog(), users: async () => undefined,
  });
  await notifier.notify({
    type: 'subscription_expiring', userId: 'ghost', subscriptionId: 's', planId: 'monthly',
    expiresAt: Date.now(), at: Date.now(),
  });
  assert.equal(sender.sent.length, 0);
});
