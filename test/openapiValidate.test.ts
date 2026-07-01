import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildOpenApiSpec } from '../src/api/openapi';

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch'];

/** Recursively collect every `$ref` string value anywhere in the document. */
function collectRefs(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === '$ref' && typeof value === 'string') {
        out.push(value);
      } else {
        collectRefs(value, out);
      }
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

test('buildOpenApiSpec produces a structurally valid OpenAPI 3.0.3 document', () => {
  const spec = buildOpenApiSpec(['wechat', 'alipay', 'usdt']) as Record<string, unknown>;

  // openapi version
  assert.equal(spec.openapi, '3.0.3');

  // info.title / info.version are non-empty strings
  const info = spec.info as Record<string, unknown>;
  assert.ok(isObject(info), 'info must be an object');
  assert.equal(typeof info.title, 'string');
  assert.ok((info.title as string).length > 0, 'info.title must be non-empty');
  assert.equal(typeof info.version, 'string');
  assert.ok((info.version as string).length > 0, 'info.version must be non-empty');

  // paths is a non-empty object
  const paths = spec.paths as Record<string, unknown>;
  assert.ok(isObject(paths), 'paths must be an object');
  const pathKeys = Object.keys(paths);
  assert.ok(pathKeys.length > 0, 'paths must be non-empty');

  for (const pathKey of pathKeys) {
    // every path key starts with '/'
    assert.ok(pathKey.startsWith('/'), `path key must start with '/': ${pathKey}`);

    const pathItem = paths[pathKey];
    assert.ok(isObject(pathItem), `path item must be an object: ${pathKey}`);

    // every operation has at least one HTTP method
    const ops = HTTP_METHODS.filter((m) => m in pathItem);
    assert.ok(ops.length > 0, `path must have at least one HTTP method: ${pathKey}`);

    for (const method of ops) {
      const op = pathItem[method];
      assert.ok(isObject(op), `operation must be an object: ${method} ${pathKey}`);
      const responses = op.responses;
      assert.ok(isObject(responses), `operation must have responses: ${method} ${pathKey}`);
      assert.ok(
        Object.keys(responses).length > 0,
        `operation must have at least one status code: ${method} ${pathKey}`,
      );
    }
  }

  // every $ref points at #/components/schemas/<Name> and that schema exists
  const components = spec.components as Record<string, unknown>;
  assert.ok(isObject(components), 'components must be an object');
  const schemas = components.schemas as Record<string, unknown>;
  assert.ok(isObject(schemas), 'components.schemas must be an object');

  const refs: string[] = [];
  collectRefs(spec, refs);
  for (const r of refs) {
    const prefix = '#/components/schemas/';
    assert.ok(r.startsWith(prefix), `$ref must point at a component schema: ${r}`);
    const name = r.slice(prefix.length);
    assert.ok(name.length > 0, `$ref must name a schema: ${r}`);
    assert.ok(
      Object.prototype.hasOwnProperty.call(schemas, name),
      `$ref target schema does not exist: ${name}`,
    );
  }

  // securitySchemes.bearerAuth exists
  const securitySchemes = components.securitySchemes as Record<string, unknown>;
  assert.ok(isObject(securitySchemes), 'components.securitySchemes must be an object');
  assert.ok('bearerAuth' in securitySchemes, 'components.securitySchemes.bearerAuth must exist');

  // the /api/v1 mirror is present alongside the un-versioned path
  assert.ok('/api/plans' in paths, '/api/plans must exist');
  assert.ok('/api/v1/plans' in paths, '/api/v1/plans must exist (mirror)');

  // the document is JSON-serialisable (no cycles)
  assert.doesNotThrow(() => JSON.stringify(spec), 'spec must be JSON-serialisable');
});
