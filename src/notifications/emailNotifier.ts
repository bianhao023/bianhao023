import { Notifier, NotificationEvent } from './notifier';
import { renderEmail, EmailType } from './emailTemplates';
import { PlanCatalog } from '../services/plans';
import { logger } from '../utils/logger';

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Delivers an email. Implement with SMTP / SES / a provider API in production. */
export interface MailSender {
  send(email: OutgoingEmail): Promise<void>;
}

/** Logs emails instead of sending — safe default for dev. */
export class ConsoleMailSender implements MailSender {
  async send(email: OutgoingEmail): Promise<void> {
    logger.info('email (console)', { to: email.to, subject: email.subject });
  }
}

/** Captures emails in memory — for tests. */
export class RecordingMailSender implements MailSender {
  readonly sent: OutgoingEmail[] = [];
  async send(email: OutgoingEmail): Promise<void> {
    this.sent.push(email);
  }
}

export interface UserContact {
  email: string;
  locale?: string;
  name?: string;
}

/** Resolves a user id to their contact details (email + preferred locale). */
export type UserLookup = (userId: string) => Promise<UserContact | undefined>;

export interface TemplatedEmailNotifierDeps {
  sender: MailSender;
  users: UserLookup;
  plans: PlanCatalog;
}

const EVENT_TO_EMAIL: Record<NotificationEvent['type'], EmailType> = {
  subscription_expiring: 'expiry_reminder',
  subscription_expired: 'expired_notice',
};

/**
 * A Notifier that renders localized billing emails and hands them to a
 * MailSender. Users without an email on file are skipped.
 */
export class TemplatedEmailNotifier implements Notifier {
  constructor(private readonly deps: TemplatedEmailNotifierDeps) {}

  async notify(event: NotificationEvent): Promise<void> {
    const contact = await this.deps.users(event.userId);
    if (!contact?.email) {
      logger.warn('no email on file; skipping notification', { userId: event.userId });
      return;
    }
    const plan = this.deps.plans.getPlan(event.planId);
    const rendered = renderEmail(EVENT_TO_EMAIL[event.type], contact.locale ?? 'en', {
      userName: contact.name,
      planName: plan?.name ?? event.planId,
      expiryDate: new Date(event.expiresAt).toISOString().slice(0, 10),
    });
    await this.deps.sender.send({ to: contact.email, ...rendered });
  }
}
