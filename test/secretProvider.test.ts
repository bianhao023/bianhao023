import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EnvSecretProvider,
  StaticSecretProvider,
  Secret,
} from '../src/secrets/secretProvider';

test('EnvSecretProvider.get returns value, treats empty/missing as unset', () => {
  const env: NodeJS.ProcessEnv = { TOKEN: 'abc', EMPTY: '' };
  const provider = new EnvSecretProvider(env);
  assert.equal(provider.get('TOKEN'), 'abc');
  assert.equal(provider.get('EMPTY'), undefined);
  assert.equal(provider.get('MISSING'), undefined);
});

test('EnvSecretProvider.getRotating returns current + previous', () => {
  const env: NodeJS.ProcessEnv = { TOKEN: 'new', TOKEN_PREVIOUS: 'old' };
  const provider = new EnvSecretProvider(env);
  assert.deepEqual(provider.getRotating('TOKEN'), { current: 'new', previous: 'old' });
});

test('EnvSecretProvider.getRotating omits previous when unset', () => {
  const env: NodeJS.ProcessEnv = { TOKEN: 'new', TOKEN_PREVIOUS: '' };
  const provider = new EnvSecretProvider(env);
  const result = provider.getRotating('TOKEN');
  assert.deepEqual(result, { current: 'new' });
  assert.equal('previous' in (result as Secret), false);
});

test('EnvSecretProvider.getRotating returns undefined when current unset', () => {
  const provider = new EnvSecretProvider({ TOKEN_PREVIOUS: 'old' });
  assert.equal(provider.getRotating('TOKEN'), undefined);
});

test('StaticSecretProvider handles string entries (no previous)', () => {
  const provider = new StaticSecretProvider({ TOKEN: 'plain' });
  assert.equal(provider.get('TOKEN'), 'plain');
  assert.deepEqual(provider.getRotating('TOKEN'), { current: 'plain' });
  assert.equal('previous' in (provider.getRotating('TOKEN') as Secret), false);
});

test('StaticSecretProvider handles Secret entries (with previous)', () => {
  const provider = new StaticSecretProvider({
    TOKEN: { current: 'new', previous: 'old' },
  });
  assert.equal(provider.get('TOKEN'), 'new');
  assert.deepEqual(provider.getRotating('TOKEN'), { current: 'new', previous: 'old' });
});

test('StaticSecretProvider returns undefined for unknown names', () => {
  const provider = new StaticSecretProvider({ TOKEN: 'plain' });
  assert.equal(provider.get('MISSING'), undefined);
  assert.equal(provider.getRotating('MISSING'), undefined);
});
