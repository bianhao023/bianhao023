/**
 * Secret abstraction: a thin, pure layer between the app and wherever secrets
 * actually live. Today secrets come from environment variables; tomorrow they
 * may come from AWS KMS/Secrets Manager or HashiCorp Vault. Callers depend only
 * on the `SecretProvider` interface, so swapping the backing store is a matter
 * of constructing a different provider at startup — no call-site changes.
 */

/**
 * A secret value plus an optional previous value retained during rotation.
 * Keeping `previous` lets verifiers accept credentials signed with the old
 * secret for a grace window while clients migrate to `current`.
 */
export interface Secret {
  current: string;
  previous?: string;
}

/** Read-only access to named secrets. */
export interface SecretProvider {
  /** Return the current value for `name`, or undefined if unset. */
  get(name: string): string | undefined;
  /**
   * Return `{ current, previous }` for `name`, or undefined if `current` is
   * unset. `previous` is omitted when there is no prior value in rotation.
   */
  getRotating(name: string): Secret | undefined;
}

/** Treat undefined and empty string alike as "unset". */
function normalizeValue(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Environment-variable backed provider. The previous value of a rotating
 * secret is read from `${name}_PREVIOUS` by convention (mirroring the existing
 * `ADMIN_TOKEN` / `ADMIN_TOKEN_PREVIOUS` pattern in config).
 */
export class EnvSecretProvider implements SecretProvider {
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  get(name: string): string | undefined {
    return normalizeValue(this.env[name]);
  }

  getRotating(name: string): Secret | undefined {
    const current = this.get(name);
    if (current === undefined) return undefined;
    const previous = normalizeValue(this.env[`${name}_PREVIOUS`]);
    return previous === undefined ? { current } : { current, previous };
  }
}

/**
 * In-memory provider seeded from a static map. Each entry is either a plain
 * string (no previous value) or a full `Secret`. Handy for tests and for
 * composing secrets loaded from other sources.
 */
export class StaticSecretProvider implements SecretProvider {
  private readonly secrets: Map<string, Secret>;

  constructor(secrets: Record<string, Secret | string>) {
    this.secrets = new Map();
    for (const [name, value] of Object.entries(secrets)) {
      this.secrets.set(name, typeof value === 'string' ? { current: value } : value);
    }
  }

  get(name: string): string | undefined {
    return this.secrets.get(name)?.current;
  }

  getRotating(name: string): Secret | undefined {
    const secret = this.secrets.get(name);
    if (secret === undefined) return undefined;
    return secret.previous === undefined
      ? { current: secret.current }
      : { current: secret.current, previous: secret.previous };
  }
}

/*
 * Future KMS/Vault providers implement this same `SecretProvider` interface.
 * For example, a `VaultSecretProvider` would fetch the versioned secret at a
 * given path, map the newest version to `current` and the prior version to
 * `previous`, and (typically) cache values with a TTL. Because the interface is
 * synchronous, such a provider would prime its cache on startup / refresh in
 * the background rather than block on `get`. Callers remain unchanged.
 */
