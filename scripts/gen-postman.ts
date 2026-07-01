/**
 * Generate a Postman Collection (v2.1.0) from the OpenAPI spec.
 *
 * Usage:
 *   npm run build && node dist/scripts/gen-postman.js > vpn-payment.postman_collection.json
 *
 * The generated collection groups requests into folders by the operation's first
 * OpenAPI tag, wires `{{baseUrl}}` / `{{token}}` collection variables, and adds
 * Content-Type / Authorization headers where the operation calls for them.
 */

import { buildOpenApiSpec } from '../src/api/openapi';

/** Postman schema URL for Collection format v2.1.0. */
const POSTMAN_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

/** HTTP methods that may appear as keys under a path item. */
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];

/** A Postman header entry. */
interface PostmanHeader {
  key: string;
  value: string;
}

/**
 * Convert an OpenAPI-style path (`/api/orders/{id}`) into a Postman-style path
 * (`/api/orders/:id`).
 */
function toPostmanPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ':$1');
}

/** Read `spec.info.title`, falling back to a sensible default. */
function specTitle(spec: Record<string, unknown>): string {
  const info = spec.info as Record<string, unknown> | undefined;
  const title = info?.title;
  return typeof title === 'string' && title.length > 0 ? title : 'API';
}

/**
 * Build the header array for a single operation:
 * - `Content-Type: application/json` when the operation has a request body.
 * - `Authorization: Bearer {{token}}` when the operation has a non-empty
 *   `security` array.
 */
function buildHeaders(operation: Record<string, unknown>): PostmanHeader[] {
  const headers: PostmanHeader[] = [];

  if (operation.requestBody !== undefined && operation.requestBody !== null) {
    headers.push({ key: 'Content-Type', value: 'application/json' });
  }

  const security = operation.security;
  if (Array.isArray(security) && security.length > 0) {
    headers.push({ key: 'Authorization', value: 'Bearer {{token}}' });
  }

  return headers;
}

/** Build a single Postman request item for one path + method + operation. */
function buildRequestItem(
  path: string,
  method: string,
  operation: Record<string, unknown>,
): Record<string, unknown> {
  const postmanPath = toPostmanPath(path);
  const summary = operation.summary;
  const name =
    typeof summary === 'string' && summary.length > 0
      ? summary
      : `${method.toUpperCase()} ${path}`;

  const pathSegments = postmanPath.split('/').filter((seg) => seg.length > 0);

  return {
    name,
    request: {
      method: method.toUpperCase(),
      header: buildHeaders(operation),
      url: {
        raw: `{{baseUrl}}${postmanPath}`,
        host: ['{{baseUrl}}'],
        path: pathSegments,
      },
    },
  };
}

/**
 * Build a Postman Collection v2.1.0 object from an OpenAPI 3.x document.
 */
export function buildPostmanCollection(spec: Record<string, unknown>): Record<string, unknown> {
  const paths = (spec.paths as Record<string, unknown> | undefined) ?? {};

  // Preserve first-seen folder order.
  const folders = new Map<string, Record<string, unknown>[]>();

  const getFolder = (tag: string): Record<string, unknown>[] => {
    let items = folders.get(tag);
    if (!items) {
      items = [];
      folders.set(tag, items);
    }
    return items;
  };

  for (const path of Object.keys(paths)) {
    const pathItem = paths[path] as Record<string, unknown>;
    if (pathItem === null || typeof pathItem !== 'object') continue;

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method] as Record<string, unknown> | undefined;
      if (operation === null || operation === undefined || typeof operation !== 'object') continue;

      const tags = operation.tags;
      const firstTag =
        Array.isArray(tags) && tags.length > 0 && typeof tags[0] === 'string'
          ? (tags[0] as string)
          : 'default';

      getFolder(firstTag).push(buildRequestItem(path, method, operation));
    }
  }

  const item: Record<string, unknown>[] = [];
  for (const [tag, requests] of folders) {
    item.push({ name: tag, item: requests });
  }

  return {
    info: {
      name: specTitle(spec),
      schema: POSTMAN_SCHEMA,
    },
    variable: [
      { key: 'baseUrl', value: 'http://localhost:3000' },
      { key: 'token', value: '' },
    ],
    item,
  };
}

/** CLI entry point: print the collection for the default enabled methods. */
function main(): void {
  const spec = buildOpenApiSpec(['wechat', 'alipay', 'usdt']);
  console.log(JSON.stringify(buildPostmanCollection(spec), null, 2));
}

if (require.main === module) {
  main();
}
