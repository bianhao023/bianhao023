import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenApiSpec } from '../src/api/openapi';
import { SWAGGER_UI_HTML } from '../src/api/docsHtml';

/** Narrow an unknown value to a plain object for property access in tests. */
function obj(v: unknown): Record<string, unknown> {
  assert.equal(typeof v, 'object');
  assert.notEqual(v, null);
  return v as Record<string, unknown>;
}

test('spec declares OpenAPI 3.0.3', () => {
  const spec = buildOpenApiSpec(['wechat', 'alipay', 'usdt']);
  assert.equal(spec.openapi, '3.0.3');
});

test('info.title is a non-empty string', () => {
  const spec = buildOpenApiSpec([]);
  const info = obj(spec.info);
  assert.equal(typeof info.title, 'string');
  assert.ok((info.title as string).length > 0);
});

test('paths include all key endpoints', () => {
  const spec = buildOpenApiSpec(['wechat']);
  const paths = obj(spec.paths);
  for (const p of [
    '/api/orders',
    '/api/orders/{id}',
    '/api/users/register',
    '/admin/reports/summary',
    '/api/notify/wechat',
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(paths, p), `missing path: ${p}`);
  }
});

test('bearerAuth security scheme is defined', () => {
  const spec = buildOpenApiSpec([]);
  const components = obj(spec.components);
  const schemes = obj(components.securitySchemes);
  const bearer = obj(schemes.bearerAuth);
  assert.equal(bearer.type, 'http');
  assert.equal(bearer.scheme, 'bearer');
});

test('GET /api/users/me requires bearerAuth', () => {
  const spec = buildOpenApiSpec([]);
  const paths = obj(spec.paths);
  const me = obj(paths['/api/users/me']);
  const getOp = obj(me.get);
  const security = getOp.security;
  assert.ok(Array.isArray(security), 'me operation must declare security');
  const names = (security as Record<string, unknown>[]).flatMap((entry) => Object.keys(entry));
  assert.ok(names.includes('bearerAuth'), 'me operation must list bearerAuth');
});

test('spec is JSON-serialisable', () => {
  const spec = buildOpenApiSpec(['wechat', 'alipay', 'usdt']);
  assert.doesNotThrow(() => JSON.stringify(spec));
});

test('Swagger UI HTML references swagger-ui and the spec url', () => {
  assert.ok(SWAGGER_UI_HTML.includes('swagger-ui'));
  assert.ok(SWAGGER_UI_HTML.includes('/openapi.json'));
});
