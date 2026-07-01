import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Subscription } from '../src/domain/types';
import { MemorySubscriptionRepository } from '../src/storage/memoryStore';
import { RecordingNotifier } from '../src/notifications/notifier';
import { ExpiryService } from '../src/services/expiryService';

const DAY = 24 * 60 * 60 * 1000;

function sub(over: Partial<Subscription> & { id: string; userId: string; expiresAt: number }): Subscription {
  return {
    planId: 'monthly', startsAt: 0, trafficGb: 200, deviceLimit: 3, active: true,
    orderIds: ['o1'], createdAt: 0, updatedAt: 0, ...over,
  };
}

function make(now: number) {
  const subs = new MemorySubscriptionRepository();
  const notifier = new RecordingNotifier();
  const service = new ExpiryService({ subscriptions: subs, notifier, reminderWindowMs: 3 * DAY, now: () => now });
  return { subs, notifier, service };
}

test('reminder is sent once for a subscription expiring within the window', async () => {
  const now = Date.UTC(2026, 0, 10);
  const { subs, notifier, service } = make(now);
  await subs.create(sub({ id: 's1', userId: 'u1', expiresAt: now + 2 * DAY }));

  assert.equal(await service.sendExpiryReminders(), 1);
  assert.equal(notifier.events.length, 1);
  assert.equal(notifier.events[0].type, 'subscription_expiring');

  // Idempotent: not sent again.
  assert.equal(await service.sendExpiryReminders(), 0);
  assert.equal(notifier.events.length, 1);
});

test('no reminder for a subscription expiring beyond the window', async () => {
  const now = Date.UTC(2026, 0, 10);
  const { subs, service, notifier } = make(now);
  await subs.create(sub({ id: 's1', userId: 'u1', expiresAt: now + 10 * DAY }));
  assert.equal(await service.sendExpiryReminders(), 0);
  assert.equal(notifier.events.length, 0);
});

test('expired subscriptions are deactivated and the user notified', async () => {
  const now = Date.UTC(2026, 0, 10);
  const { subs, notifier, service } = make(now);
  await subs.create(sub({ id: 's1', userId: 'u1', expiresAt: now - 1 }));
  await subs.create(sub({ id: 's2', userId: 'u2', expiresAt: now + 5 * DAY }));

  assert.equal(await service.deactivateExpired(), 1);
  assert.equal(await subs.findActiveByUser('u1'), undefined);
  assert.ok(await subs.findActiveByUser('u2')); // still active
  assert.equal(notifier.events.filter((e) => e.type === 'subscription_expired').length, 1);

  // Idempotent: already-deactivated subs are not processed again.
  assert.equal(await service.deactivateExpired(), 0);
});

test('renewal (cleared expiryNotifiedAt) allows a fresh reminder', async () => {
  const now = Date.UTC(2026, 0, 10);
  const { subs, service } = make(now);
  await subs.create(sub({ id: 's1', userId: 'u1', expiresAt: now + 2 * DAY }));
  await service.sendExpiryReminders(); // first reminder

  // Simulate a renewal that extends expiry and resets the reminder flag.
  const current = await subs.findActiveByUser('u1');
  await subs.update({ ...current!, expiresAt: now + 1 * DAY, expiryNotifiedAt: undefined });

  assert.equal(await service.sendExpiryReminders(), 1); // reminds again for new period
});
