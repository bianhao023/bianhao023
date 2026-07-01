/** A registered account that can own subscriptions and receive billing emails. */
export interface User {
  id: string;
  /** Lower-cased, unique. */
  email: string;
  /** Preferred email locale (e.g. 'zh-CN', 'en'). */
  locale: string;
  name?: string;
  /** scrypt hash stored as `salt:hash` (hex). Never returned to clients. */
  passwordHash: string;
  /** Opaque API key used to authenticate API requests. */
  apiKey: string;
  createdAt: number;
  updatedAt: number;
}

/** The public projection of a user (never includes secrets). */
export interface PublicUser {
  id: string;
  email: string;
  locale: string;
  name?: string;
  createdAt: number;
}

export function toPublicUser(u: User): PublicUser {
  return { id: u.id, email: u.email, locale: u.locale, name: u.name, createdAt: u.createdAt };
}
