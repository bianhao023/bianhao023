/**
 * OpenAPI 3.0.3 specification builder for the VPN Payment Backend HTTP API.
 *
 * This module is self-contained (no runtime dependencies) and produces a plain
 * JSON-serialisable object describing every HTTP endpoint exposed by the router
 * in `./routes.ts`. It is served at `/openapi.json` and rendered by the Swagger
 * UI page in `./docsHtml.ts` (served at `/docs`).
 *
 * Monetary values in this API are ALWAYS integers in the currency's minor units
 * (CNY: fen, 1 CNY = 100; USDT: micro, 1 USDT = 1_000_000).
 */

const JSON_CONTENT = 'application/json';

/** A `$ref` pointer to a component schema. */
function ref(name: string): Record<string, unknown> {
  return { $ref: `#/components/schemas/${name}` };
}

/** A JSON request body wrapping a schema (by ref or inline). */
function jsonBody(schema: Record<string, unknown>, required = true): Record<string, unknown> {
  return {
    required,
    content: { [JSON_CONTENT]: { schema } },
  };
}

/** A JSON response with a description and schema. */
function jsonResponse(description: string, schema: Record<string, unknown>): Record<string, unknown> {
  return {
    description,
    content: { [JSON_CONTENT]: { schema } },
  };
}

/** Standard error responses referencing the shared ErrorResponse schema. */
function errorResponse(description: string): Record<string, unknown> {
  return jsonResponse(description, ref('ErrorResponse'));
}

/**
 * Build the OpenAPI 3.0.3 document.
 *
 * @param enabledMethods payment methods currently enabled on this deployment
 *   (e.g. `['wechat', 'alipay', 'usdt']`). Surfaced in the description so the
 *   docs reflect the live configuration.
 */
export function buildOpenApiSpec(enabledMethods: string[]): Record<string, unknown> {
  const methodsNote =
    enabledMethods.length > 0
      ? `Enabled payment methods on this deployment: ${enabledMethods.join(', ')}.`
      : 'No payment methods are currently enabled on this deployment.';

  const spec: Record<string, unknown> = {
    openapi: '3.0.3',
    info: {
      title: 'VPN Payment Backend API',
      version: '1.0.0',
      description:
        'Commercial-grade payment backend for a VPN service. Supports WeChat Pay, ' +
        'Alipay and USDT (TRC20). All monetary amounts are integers in minor units ' +
        '(CNY: fen; USDT: micro, 6 decimals). ' +
        'Every `/api/*` endpoint is also served under the explicit `/api/v1/*` alias; ' +
        'both are canonical for the current major version. Responses carry an ' +
        '`X-API-Version` header indicating the resolved API version. ' +
        methodsNote,
    },
    servers: [{ url: '/', description: 'Current deployment' }],
    tags: [
      { name: 'Health', description: 'Liveness, metrics and API documentation.' },
      { name: 'Plans', description: 'Purchasable VPN plans and pricing.' },
      { name: 'Accounts', description: 'User registration, login and API-key management.' },
      { name: 'Orders', description: 'Order creation, lookup and settlement.' },
      { name: 'Refunds', description: 'Full and partial refunds.' },
      { name: 'Webhooks', description: 'Provider callbacks with raw signed bodies.' },
      { name: 'Admin', description: 'Reporting and reconciliation (bearer-token protected).' },
    ],
    paths: {
      // ── Health / meta ─────────────────────────────────────────────────────
      '/healthz': {
        get: {
          tags: ['Health'],
          summary: 'Liveness probe',
          operationId: 'getHealthz',
          responses: {
            '200': jsonResponse('Service is healthy.', {
              type: 'object',
              properties: {
                status: { type: 'string', example: 'ok' },
                methods: { type: 'array', items: ref('PaymentMethod') },
              },
              required: ['status', 'methods'],
            }),
          },
        },
      },
      '/metrics': {
        get: {
          tags: ['Health'],
          summary: 'Prometheus metrics scrape endpoint',
          operationId: 'getMetrics',
          responses: {
            '200': {
              description: 'Prometheus text exposition format.',
              content: {
                'text/plain': { schema: { type: 'string' } },
              },
            },
          },
        },
      },
      '/openapi.json': {
        get: {
          tags: ['Health'],
          summary: 'This OpenAPI 3.0.3 specification as JSON',
          operationId: 'getOpenApiJson',
          responses: {
            '200': jsonResponse('The OpenAPI document.', { type: 'object' }),
          },
        },
      },
      '/docs': {
        get: {
          tags: ['Health'],
          summary: 'Swagger UI documentation page',
          operationId: 'getDocs',
          responses: {
            '200': {
              description: 'An HTML page rendering the API docs.',
              content: { 'text/html': { schema: { type: 'string' } } },
            },
          },
        },
      },

      // ── Plans ─────────────────────────────────────────────────────────────
      '/api/plans': {
        get: {
          tags: ['Plans'],
          summary: 'List purchasable plans',
          operationId: 'listPlans',
          responses: {
            '200': jsonResponse('Available plans and enabled payment methods.', {
              type: 'object',
              properties: {
                plans: { type: 'array', items: ref('Plan') },
                enabledMethods: { type: 'array', items: ref('PaymentMethod') },
              },
              required: ['plans', 'enabledMethods'],
            }),
          },
        },
      },

      // ── Accounts ──────────────────────────────────────────────────────────
      '/api/users/register': {
        post: {
          tags: ['Accounts'],
          summary: 'Register a new account',
          operationId: 'registerUser',
          requestBody: jsonBody(ref('RegisterRequest')),
          responses: {
            '201': jsonResponse('Account created; returns the user and its API key.', ref('AuthResult')),
            '400': errorResponse('Invalid request body.'),
            '409': errorResponse('Email already registered.'),
          },
        },
      },
      '/api/users/login': {
        post: {
          tags: ['Accounts'],
          summary: 'Log in and obtain an API key',
          operationId: 'loginUser',
          requestBody: jsonBody(ref('LoginRequest')),
          responses: {
            '200': jsonResponse('Authenticated; returns the user and its API key.', ref('AuthResult')),
            '400': errorResponse('Invalid request body.'),
            '401': errorResponse('Invalid credentials.'),
          },
        },
      },
      '/api/users/me': {
        get: {
          tags: ['Accounts'],
          summary: 'Get the authenticated user',
          operationId: 'getCurrentUser',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': jsonResponse('The authenticated user.', ref('PublicUser')),
            '401': errorResponse('Missing or invalid API key.'),
          },
        },
      },
      '/api/users/me/rotate-key': {
        post: {
          tags: ['Accounts'],
          summary: 'Rotate the authenticated user API key',
          operationId: 'rotateApiKey',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': jsonResponse('The new API key.', {
              type: 'object',
              properties: { apiKey: { type: 'string' } },
              required: ['apiKey'],
            }),
            '401': errorResponse('Missing or invalid API key.'),
          },
        },
      },

      // ── Orders ────────────────────────────────────────────────────────────
      '/api/orders': {
        post: {
          tags: ['Orders'],
          summary: 'Create an order and start a payment',
          operationId: 'createOrder',
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: false,
              description: 'Optional key to dedupe order creation across retries.',
              schema: { type: 'string' },
            },
          ],
          requestBody: jsonBody(ref('CreateOrderRequest')),
          responses: {
            '201': jsonResponse('Order created with provider pay information.', ref('OrderWithPayInfo')),
            '400': errorResponse('Invalid body or payment method not enabled.'),
            '404': errorResponse('Plan or user not found.'),
          },
        },
      },
      '/api/orders/{id}': {
        get: {
          tags: ['Orders'],
          summary: 'Get an order by id',
          operationId: 'getOrder',
          parameters: [orderIdParam()],
          responses: {
            '200': jsonResponse('The order.', ref('Order')),
            '404': errorResponse('Order not found.'),
          },
        },
      },
      '/api/orders/{id}/sync': {
        post: {
          tags: ['Orders'],
          summary: 'Poll the provider and settle the order if paid',
          operationId: 'syncOrder',
          parameters: [orderIdParam()],
          responses: {
            '200': jsonResponse('The (possibly updated) order.', ref('Order')),
            '404': errorResponse('Order not found.'),
          },
        },
      },
      '/api/orders/{id}/refund': {
        post: {
          tags: ['Refunds'],
          summary: 'Refund an order (full or partial)',
          operationId: 'refundOrder',
          parameters: [orderIdParam()],
          requestBody: jsonBody(ref('RefundRequest'), false),
          responses: {
            '201': jsonResponse('Refund created.', ref('Refund')),
            '400': errorResponse('Invalid amount or order not refundable.'),
            '404': errorResponse('Order not found.'),
          },
        },
      },
      '/api/orders/{id}/refunds': {
        get: {
          tags: ['Refunds'],
          summary: 'List refunds for an order',
          operationId: 'listOrderRefunds',
          parameters: [orderIdParam()],
          responses: {
            '200': jsonResponse('Refunds for the order.', {
              type: 'object',
              properties: { refunds: { type: 'array', items: ref('Refund') } },
              required: ['refunds'],
            }),
            '404': errorResponse('Order not found.'),
          },
        },
      },

      // ── Webhooks ──────────────────────────────────────────────────────────
      '/api/notify/wechat': {
        post: webhookOperation('WeChat Pay payment callback', 'wechatNotify'),
      },
      '/api/notify/wechat/refund': {
        post: webhookOperation('WeChat Pay refund-result callback', 'wechatRefundNotify'),
      },
      '/api/notify/alipay': {
        post: webhookOperation('Alipay payment callback', 'alipayNotify'),
      },

      // ── Internal ──────────────────────────────────────────────────────────
      '/internal/usdt/reconcile': {
        post: {
          tags: ['Admin'],
          summary: 'Trigger a USDT on-chain reconciliation pass',
          operationId: 'reconcileUsdt',
          responses: {
            '200': jsonResponse('Number of orders settled by this pass.', {
              type: 'object',
              properties: { settled: { type: 'integer' } },
              required: ['settled'],
            }),
          },
        },
      },

      // ── Admin ─────────────────────────────────────────────────────────────
      '/admin/reports/summary': {
        get: {
          tags: ['Admin'],
          summary: 'Aggregate revenue / order report',
          operationId: 'adminReportSummary',
          security: [{ bearerAuth: [] }],
          parameters: reportFilterParams(),
          responses: {
            '200': jsonResponse('The report summary.', { type: 'object', additionalProperties: true }),
            '401': errorResponse('Missing or invalid admin token.'),
            '403': errorResponse('Admin endpoints disabled.'),
          },
        },
      },
      '/admin/orders': {
        get: {
          tags: ['Admin'],
          summary: 'List orders (paginated)',
          operationId: 'adminListOrders',
          security: [{ bearerAuth: [] }],
          parameters: [...reportFilterParams(), ...paginationParams()],
          responses: {
            '200': jsonResponse('Paginated orders.', paginatedSchema(ref('Order'))),
            '401': errorResponse('Missing or invalid admin token.'),
            '403': errorResponse('Admin endpoints disabled.'),
          },
        },
      },
      '/admin/refunds': {
        get: {
          tags: ['Admin'],
          summary: 'List refunds (paginated)',
          operationId: 'adminListRefunds',
          security: [{ bearerAuth: [] }],
          parameters: paginationParams(),
          responses: {
            '200': jsonResponse('Paginated refunds.', paginatedSchema(ref('Refund'))),
            '401': errorResponse('Missing or invalid admin token.'),
            '403': errorResponse('Admin endpoints disabled.'),
          },
        },
      },
      '/admin/expiry/run': {
        post: {
          tags: ['Admin'],
          summary: 'Run an expiry pass (reminders + deactivation)',
          operationId: 'adminRunExpiry',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': jsonResponse('Counts of reminders sent and subs deactivated.', {
              type: 'object',
              properties: {
                reminders: { type: 'integer' },
                deactivated: { type: 'integer' },
              },
              required: ['reminders', 'deactivated'],
            }),
            '401': errorResponse('Missing or invalid admin token.'),
            '403': errorResponse('Admin endpoints disabled.'),
          },
        },
      },
    },

    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'For user endpoints, pass the account API key as `Authorization: Bearer <apiKey>`. ' +
            'For /admin endpoints, pass the configured admin token.',
        },
      },
      schemas: {
        PaymentMethod: {
          type: 'string',
          enum: ['wechat', 'alipay', 'usdt'],
        },
        Currency: {
          type: 'string',
          enum: ['CNY', 'USDT'],
        },
        OrderStatus: {
          type: 'string',
          enum: ['PENDING', 'PAID', 'FULFILLED', 'EXPIRED', 'CANCELLED', 'REFUNDED', 'FAILED'],
        },
        Plan: {
          type: 'object',
          description: 'A purchasable VPN plan. Prices are integers in minor units.',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            durationDays: { type: 'integer' },
            trafficGb: { type: 'integer', description: '0 means unlimited.' },
            deviceLimit: { type: 'integer' },
            priceCnyFen: { type: 'integer', description: 'Price in CNY minor units (fen).' },
            priceUsdtMicro: { type: 'integer', description: 'Price in USDT minor units (micro).' },
            enabled: { type: 'boolean' },
            priceCnyDisplay: { type: 'string', description: 'Human-readable CNY price.' },
            priceUsdtDisplay: { type: 'string', description: 'Human-readable USDT price.' },
          },
          required: ['id', 'name', 'durationDays', 'priceCnyFen', 'priceUsdtMicro', 'enabled'],
        },
        Order: {
          type: 'object',
          description: 'Public projection of an order. Amounts are integers in minor units.',
          properties: {
            orderId: { type: 'string' },
            outTradeNo: { type: 'string', description: 'Merchant order number (out_trade_no).' },
            userId: { type: 'string' },
            planId: { type: 'string' },
            method: ref('PaymentMethod'),
            currency: ref('Currency'),
            amount: { type: 'integer', description: 'Amount due in minor units.' },
            amountDisplay: { type: 'string' },
            status: ref('OrderStatus'),
            refundedAmount: { type: 'integer', description: 'Total refunded so far, in minor units.' },
            providerTxnId: { type: 'string', nullable: true },
            createdAt: { type: 'integer', description: 'Epoch millis.' },
            expiresAt: { type: 'integer', description: 'Epoch millis.' },
            paidAt: { type: 'integer', nullable: true, description: 'Epoch millis.' },
          },
          required: ['orderId', 'outTradeNo', 'planId', 'method', 'currency', 'amount', 'status'],
        },
        OrderWithPayInfo: {
          allOf: [
            ref('Order'),
            {
              type: 'object',
              properties: {
                payInfo: {
                  type: 'object',
                  description: 'Provider-specific pay target (QR payload, address or redirect URL).',
                  additionalProperties: true,
                  nullable: true,
                },
              },
            },
          ],
        },
        Refund: {
          type: 'object',
          description: 'A refund against an order. Amounts are integers in minor units.',
          properties: {
            id: { type: 'string' },
            orderId: { type: 'string' },
            outRefundNo: { type: 'string', description: 'Merchant refund number.' },
            amount: { type: 'integer', description: 'Refund amount in minor units.' },
            currency: ref('Currency'),
            status: { type: 'string' },
            reason: { type: 'string', nullable: true },
            createdAt: { type: 'integer', nullable: true, description: 'Epoch millis.' },
          },
          required: ['id', 'orderId', 'outRefundNo', 'amount', 'currency', 'status'],
        },
        PublicUser: {
          type: 'object',
          description: 'Public projection of a user (never includes secrets).',
          properties: {
            id: { type: 'string' },
            email: { type: 'string', format: 'email' },
            locale: { type: 'string', example: 'zh-CN' },
            name: { type: 'string', nullable: true },
            createdAt: { type: 'integer', description: 'Epoch millis.' },
          },
          required: ['id', 'email', 'locale', 'createdAt'],
        },
        AuthResult: {
          type: 'object',
          description: 'A user together with its API key (returned on register/login).',
          properties: {
            user: ref('PublicUser'),
            apiKey: { type: 'string', description: 'Opaque API key for Bearer auth.' },
          },
          required: ['user', 'apiKey'],
        },
        RegisterRequest: {
          type: 'object',
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string', format: 'password' },
            locale: { type: 'string', nullable: true, example: 'zh-CN' },
            name: { type: 'string', nullable: true },
          },
          required: ['email', 'password'],
        },
        LoginRequest: {
          type: 'object',
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string', format: 'password' },
          },
          required: ['email', 'password'],
        },
        CreateOrderRequest: {
          type: 'object',
          properties: {
            userId: { type: 'string' },
            planId: { type: 'string' },
            method: ref('PaymentMethod'),
            idempotencyKey: {
              type: 'string',
              nullable: true,
              description: 'Alternative to the Idempotency-Key header.',
            },
          },
          required: ['userId', 'planId', 'method'],
        },
        RefundRequest: {
          type: 'object',
          description: 'Omit amount for a full refund.',
          properties: {
            amount: { type: 'integer', nullable: true, description: 'Partial refund amount in minor units.' },
            reason: { type: 'string', nullable: true },
            outRefundNo: { type: 'string', nullable: true, description: 'Optional merchant refund number.' },
          },
        },
        ErrorResponse: {
          type: 'object',
          description: 'Standard error envelope.',
          properties: {
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'VALIDATION_ERROR' },
                message: { type: 'string' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['error'],
        },
      },
    },
  };

  // Mirror every un-versioned `/api/*` path under the explicit `/api/v1/*` alias
  // (see `r.aliasPrefix('/api', '/api/v1')` in routes.ts). Done generically so it
  // stays correct as routes change. The same operation object is shared under both
  // keys — this is fine for JSON.stringify (shared refs are not cycles). Non-`/api`
  // paths (healthz, metrics, docs, openapi.json, admin, internal, ...) are not mirrored.
  const paths = spec.paths as Record<string, unknown>;
  for (const key of Object.keys(paths)) {
    if (key.startsWith('/api/')) {
      const versionedKey = key.replace(/^\/api\//, '/api/v1/');
      paths[versionedKey] = paths[key];
    }
  }

  return spec;
}

/** The `{id}` path parameter shared by order routes. */
function orderIdParam(): Record<string, unknown> {
  return {
    name: 'id',
    in: 'path',
    required: true,
    description: 'Order id.',
    schema: { type: 'string' },
  };
}

/** Query params accepted by report/list endpoints. */
function reportFilterParams(): Record<string, unknown>[] {
  return [
    { name: 'from', in: 'query', required: false, description: 'Start epoch millis (inclusive).', schema: { type: 'integer' } },
    { name: 'to', in: 'query', required: false, description: 'End epoch millis (inclusive).', schema: { type: 'integer' } },
    { name: 'method', in: 'query', required: false, schema: { $ref: '#/components/schemas/PaymentMethod' } },
    { name: 'status', in: 'query', required: false, schema: { $ref: '#/components/schemas/OrderStatus' } },
  ];
}

/** Limit/offset pagination query params. */
function paginationParams(): Record<string, unknown>[] {
  return [
    { name: 'limit', in: 'query', required: false, description: 'Max items (default 50, cap 500).', schema: { type: 'integer', minimum: 0, maximum: 500 } },
    { name: 'offset', in: 'query', required: false, description: 'Items to skip (default 0).', schema: { type: 'integer', minimum: 0 } },
  ];
}

/** A paginated list response wrapper for the given item schema. */
function paginatedSchema(itemRef: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      total: { type: 'integer' },
      limit: { type: 'integer' },
      offset: { type: 'integer' },
      items: { type: 'array', items: itemRef },
    },
    required: ['total', 'limit', 'offset', 'items'],
  };
}

/** A provider webhook operation: raw signed body in, provider-format ack out. */
function webhookOperation(summary: string, operationId: string): Record<string, unknown> {
  return {
    tags: ['Webhooks'],
    summary,
    operationId,
    description:
      'Provider callback. The raw request body is preserved for signature ' +
      'verification; do not re-encode it. Signature material is passed via ' +
      'provider-specific headers.',
    requestBody: {
      required: true,
      description: 'Raw provider-signed callback body (JSON or XML depending on provider).',
      content: {
        'application/json': { schema: { type: 'object', additionalProperties: true } },
        'application/xml': { schema: { type: 'string' } },
        'text/plain': { schema: { type: 'string' } },
      },
    },
    responses: {
      '200': {
        description: 'Acknowledgement in the provider-expected format.',
        content: {
          'application/json': { schema: { type: 'string' } },
          'application/xml': { schema: { type: 'string' } },
          'text/plain': { schema: { type: 'string' } },
        },
      },
      '400': {
        description: 'Signature verification failed or malformed callback.',
        content: { 'text/plain': { schema: { type: 'string' } } },
      },
    },
  };
}
