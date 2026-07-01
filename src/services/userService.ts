import { User, PublicUser, toPublicUser } from '../domain/user';
import { UserRepository } from '../storage/repository';
import { UserContact } from '../notifications/emailNotifier';
import { SUPPORTED_LOCALES } from '../notifications/emailTemplates';
import { ValidationError, AppError } from '../domain/errors';
import { AuditLog } from '../audit/auditLog';
import { hashPassword, verifyPassword } from '../utils/crypto';
import { uuid } from '../utils/ids';
import { randomBytes } from 'node:crypto';

class AuthFailedError extends AppError {
  constructor(message = 'invalid credentials') {
    super('AUTH_FAILED', message, 401);
  }
}

export interface RegisterInput {
  email: string;
  password: string;
  locale?: string;
  name?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Registration, authentication (password + API key), and contact resolution
 * for users. Passwords are scrypt-hashed; API keys are opaque random tokens.
 */
export class UserService {
  constructor(
    private readonly users: UserRepository,
    private readonly now: () => number = Date.now,
    private readonly audit?: AuditLog,
  ) {}

  async register(input: RegisterInput): Promise<{ user: PublicUser; apiKey: string }> {
    const email = input.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new ValidationError('invalid email address');
    if (!input.password || input.password.length < 8) {
      throw new ValidationError('password must be at least 8 characters');
    }
    const locale = input.locale && SUPPORTED_LOCALES.includes(input.locale as never) ? input.locale : 'en';

    if (await this.users.findByEmail(email)) {
      throw new ValidationError('email already registered');
    }

    const now = this.now();
    const apiKey = `vpk_${randomBytes(24).toString('hex')}`;
    const user: User = {
      id: uuid(),
      email,
      locale,
      name: input.name?.trim() || undefined,
      passwordHash: hashPassword(input.password),
      apiKey,
      createdAt: now,
      updatedAt: now,
    };
    const created = await this.users.create(user);
    await this.audit?.record({ action: 'user.registered', actor: created.id, subjectId: created.id, metadata: { email } });
    return { user: toPublicUser(created), apiKey };
  }

  /** Verify email + password, returning the user's API key on success. */
  async login(email: string, password: string): Promise<{ user: PublicUser; apiKey: string }> {
    const user = await this.users.findByEmail(email.trim().toLowerCase());
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw new AuthFailedError();
    }
    await this.audit?.record({ action: 'user.login', actor: user.id, subjectId: user.id });
    return { user: toPublicUser(user), apiKey: user.apiKey };
  }

  /** Resolve an API key to a user, or throw 401. */
  async authenticate(apiKey: string): Promise<User> {
    const user = apiKey ? await this.users.findByApiKey(apiKey) : undefined;
    if (!user) throw new AuthFailedError('invalid API key');
    return user;
  }

  /** Rotate a user's API key (invalidates the old one). */
  async rotateApiKey(userId: string): Promise<string> {
    const user = await this.users.findById(userId);
    if (!user) throw new ValidationError(`unknown user: ${userId}`);
    const apiKey = `vpk_${randomBytes(24).toString('hex')}`;
    await this.users.update({ ...user, apiKey, updatedAt: this.now() });
    return apiKey;
  }

  /** A UserLookup for the email notifier: resolves a user id to contact info. */
  contactLookup = async (userId: string): Promise<UserContact | undefined> => {
    const user = await this.users.findById(userId);
    if (!user) return undefined;
    return { email: user.email, locale: user.locale, name: user.name };
  };
}
