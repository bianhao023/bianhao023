import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryUserRepository } from '../src/storage/memoryStore';
import { UserService } from '../src/services/userService';
import { ValidationError } from '../src/domain/errors';
import { TemplatedEmailNotifier, RecordingMailSender } from '../src/notifications/emailNotifier';
import { PlanCatalog } from '../src/services/plans';

function service() {
  return new UserService(new MemoryUserRepository(), () => Date.UTC(2026, 0, 1));
}

test('register creates a user and returns an api key; secrets are not exposed', async () => {
  const svc = service();
  const { user, apiKey } = await svc.register({ email: 'A@Example.com', password: 'password1', name: 'Al', locale: 'zh-CN' });
  assert.equal(user.email, 'a@example.com'); // normalised
  assert.equal(user.locale, 'zh-CN');
  assert.match(apiKey, /^vpk_[0-9a-f]{48}$/);
  assert.equal((user as unknown as Record<string, unknown>).passwordHash, undefined);
  assert.equal((user as unknown as Record<string, unknown>).apiKey, undefined);
});

test('register validates email, password length, and duplicates', async () => {
  const svc = service();
  await assert.rejects(() => svc.register({ email: 'bad', password: 'password1' }), ValidationError);
  await assert.rejects(() => svc.register({ email: 'x@y.com', password: 'short' }), ValidationError);
  await svc.register({ email: 'dup@y.com', password: 'password1' });
  await assert.rejects(() => svc.register({ email: 'dup@y.com', password: 'password1' }), ValidationError);
});

test('unknown locale falls back to en', async () => {
  const svc = service();
  const { user } = await svc.register({ email: 'l@y.com', password: 'password1', locale: 'fr-FR' });
  assert.equal(user.locale, 'en');
});

test('login succeeds with correct password and fails otherwise', async () => {
  const svc = service();
  const reg = await svc.register({ email: 'u@y.com', password: 'password1' });
  const login = await svc.login('U@y.com', 'password1');
  assert.equal(login.apiKey, reg.apiKey);
  await assert.rejects(() => svc.login('u@y.com', 'wrong'), /AUTH_FAILED|invalid/);
  await assert.rejects(() => svc.login('nobody@y.com', 'password1'), /invalid/);
});

test('authenticate resolves api keys and rejects bad ones', async () => {
  const svc = service();
  const { apiKey } = await svc.register({ email: 'u@y.com', password: 'password1' });
  const user = await svc.authenticate(apiKey);
  assert.equal(user.email, 'u@y.com');
  await assert.rejects(() => svc.authenticate('vpk_nope'), /invalid API key/);
  await assert.rejects(() => svc.authenticate(''), /invalid API key/);
});

test('rotateApiKey invalidates the old key', async () => {
  const svc = service();
  const { user, apiKey } = await svc.register({ email: 'u@y.com', password: 'password1' });
  const next = await svc.rotateApiKey(user.id);
  assert.notEqual(next, apiKey);
  await assert.rejects(() => svc.authenticate(apiKey), /invalid API key/);
  assert.equal((await svc.authenticate(next)).id, user.id);
});

test('contactLookup feeds the email notifier with the right locale', async () => {
  const repo = new MemoryUserRepository();
  const svc = new UserService(repo, () => 0);
  const { user } = await svc.register({ email: 'buyer@y.com', password: 'password1', locale: 'zh-CN', name: '小红' });

  const sender = new RecordingMailSender();
  const notifier = new TemplatedEmailNotifier({ sender, plans: new PlanCatalog(), users: svc.contactLookup });
  await notifier.notify({
    type: 'subscription_expiring', userId: user.id, subscriptionId: 's1',
    planId: 'monthly', expiresAt: Date.UTC(2026, 6, 1), at: 0,
  });

  assert.equal(sender.sent.length, 1);
  assert.equal(sender.sent[0].to, 'buyer@y.com');
  assert.match(sender.sent[0].subject, /续费提醒/); // zh-CN template
});
