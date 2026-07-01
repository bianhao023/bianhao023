import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildOpenApiSpec } from '../src/api/openapi';
import { buildPostmanCollection } from '../scripts/gen-postman';

const POSTMAN_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

/** Recursively collect every leaf item (one that has a `request`). */
function collectLeafRequests(items: unknown): Record<string, unknown>[] {
  const leaves: Record<string, unknown>[] = [];
  if (!Array.isArray(items)) return leaves;

  for (const raw of items) {
    if (raw === null || typeof raw !== 'object') continue;
    const node = raw as Record<string, unknown>;

    if (node.request !== undefined && node.request !== null) {
      leaves.push(node.request as Record<string, unknown>);
    }
    if (Array.isArray(node.item)) {
      leaves.push(...collectLeafRequests(node.item));
    }
  }

  return leaves;
}

test('collection has valid v2.1.0 info block', () => {
  const spec = buildOpenApiSpec(['wechat']);
  const col = buildPostmanCollection(spec);

  const info = col.info as Record<string, unknown>;
  assert.equal(info.schema, POSTMAN_SCHEMA);
  assert.equal(typeof info.name, 'string');
  assert.ok((info.name as string).length > 0, 'info.name should be non-empty');
});

test('collection items form a non-empty tree of valid leaf requests', () => {
  const spec = buildOpenApiSpec(['wechat']);
  const col = buildPostmanCollection(spec);

  assert.ok(Array.isArray(col.item), 'col.item should be an array');
  assert.ok((col.item as unknown[]).length > 0, 'col.item should be non-empty');

  const leaves = collectLeafRequests(col.item);
  assert.ok(leaves.length > 0, 'expected at least one leaf request');

  for (const request of leaves) {
    assert.equal(typeof request.method, 'string');
    assert.ok((request.method as string).length > 0, 'method should be non-empty');

    const url = request.url as Record<string, unknown>;
    assert.equal(typeof url.raw, 'string');
    assert.ok(
      (url.raw as string).startsWith('{{baseUrl}}'),
      'url.raw should start with {{baseUrl}}',
    );
  }
});

test('collection includes the /api/plans request', () => {
  const spec = buildOpenApiSpec(['wechat']);
  const col = buildPostmanCollection(spec);
  const leaves = collectLeafRequests(col.item);

  const hasPlans = leaves.some((request) => {
    const url = request.url as Record<string, unknown>;
    return typeof url.raw === 'string' && (url.raw as string).includes('/api/plans');
  });
  assert.ok(hasPlans, 'expected a request for /api/plans');
});

test('a secured (/admin/...) operation carries an Authorization header', () => {
  const spec = buildOpenApiSpec(['wechat']);
  const col = buildPostmanCollection(spec);
  const leaves = collectLeafRequests(col.item);

  const securedAdmin = leaves.filter((request) => {
    const url = request.url as Record<string, unknown>;
    return typeof url.raw === 'string' && (url.raw as string).includes('/admin/');
  });
  assert.ok(securedAdmin.length > 0, 'expected at least one /admin/ request');

  const hasAuth = securedAdmin.some((request) => {
    const header = request.header;
    return (
      Array.isArray(header) &&
      header.some(
        (h) =>
          h !== null &&
          typeof h === 'object' &&
          (h as Record<string, unknown>).key === 'Authorization',
      )
    );
  });
  assert.ok(hasAuth, 'expected an Authorization header on a secured /admin/ operation');
});

test('the collection is JSON-serialisable', () => {
  const spec = buildOpenApiSpec(['wechat']);
  const col = buildPostmanCollection(spec);
  assert.doesNotThrow(() => JSON.stringify(col));
});
