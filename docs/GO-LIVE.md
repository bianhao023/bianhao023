# 上线手册 / Go-Live Runbook

面向运维人员的生产上线操作手册（VPN 支付后端）。
Operator-focused runbook for taking the VPN payment backend live.

> 重点提示 / Key facts
> - 应用只提供 **明文 HTTP**（默认监听 `PORT=3000`）；TLS 由前置的反向代理 / Ingress 终结。
>   The app serves **plain HTTP** only; TLS is terminated by an external reverse proxy / ingress.
> - 微信 / 支付宝回调**必须**是**公网 HTTPS**；USDT 无回调，靠**轮询 TronGrid** 对账。
>   WeChat/Alipay callbacks **require public HTTPS**; USDT has **no callback** and is settled by **polling TronGrid**.
> - 设置了 `DATABASE_URL` 时，应用**开机自动执行** `src/storage/sql/schema.sql` 迁移（幂等，`CREATE TABLE IF NOT EXISTS`）。
>   When `DATABASE_URL` is set the app runs `src/storage/sql/schema.sql` **automatically on boot** (idempotent).

---

## 1. 概览 / 架构 (Overview & architecture)

客户端与支付平台的流量统一经过前置反向代理（终结 TLS），再转发到应用集群，应用后端连接 Postgres 与 Redis。

```
                         :443 (HTTPS/TLS)
   ┌──────────┐        ┌───────────────────────┐        ┌──────────────────────┐
   │  Clients │  ───▶  │  Reverse proxy / LB    │  ───▶  │  app (N replicas)    │
   │ browsers │        │  (nginx / cloud LB)    │  :3000 │  node dist/src/main.js│
   │  apps    │        │  TLS termination       │  HTTP  │  (stateless HTTP)     │
   └──────────┘        └───────────┬───────────┘        └───────┬──────────────┘
                                   │                            │
   Provider callbacks             │                    ┌───────┴─────────┐
   (WeChat / Alipay)  ───▶  same proxy (HTTPS) ───▶    │                 │
   POST /api/notify/*                             ┌────▼────┐      ┌─────▼─────┐
                                                  │ Postgres│      │  Redis    │
   USDT: app POLLS TronGrid (outbound) ──────────▶│ (state, │      │ (rate     │
                                                  │  dedupe)│      │  limit)   │
                                                  └─────────┘      └───────────┘
```

- **无状态应用 / stateless app**：可水平扩容（≥2 副本）。订单与事件去重存在 DB，天然跨实例一致。
- **Redis**：仅用于**跨实例分布式限流**（进程内限流器是每实例独立的）。
- **USDT**：应用主动出站轮询 TronGrid，非平台推送。

---

## 2. 前置条件 (Prerequisites)

| 项 Item | 说明 Notes |
|---|---|
| 域名 + TLS 证书 Domain + cert | 一个可解析的域名，及有效证书（Let's Encrypt / 商业 CA / 云托管证书）。|
| 公网 HTTPS 入口 Public HTTPS endpoint | `https://<domain>` 必须公网可达，供微信/支付宝回调。 |
| 微信支付 WeChat Pay v3 | 商户号 `MCH_ID`、商户 API 私钥（PEM）、证书序列号 `SERIAL_NO`、APIv3 密钥（32 位）、平台公钥/证书。 |
| 支付宝 Alipay | 应用 `APP_ID`、应用私钥（PKCS8 PEM）、支付宝公钥（PEM）。 |
| TRON 收款地址 TRON address | 一个**你自己掌握私钥**的 TRC20 钱包地址用于收 USDT。 |
| PostgreSQL 16 | 一个可用实例（自建或云 RDS）。 |
| Redis（可选，推荐多副本时启用）| 分布式限流所需。 |
| 反向代理 / Ingress | nginx / Caddy / 云 LB，终结 TLS。 |

---

## 3. 配置 (Configuration)

所有配置通过环境变量注入。以 `.env` 为例（生产环境请改用密钥管理器，见 §10）。
带 🔒 的为**机密**，务必妥善保管、勿入库、勿打日志。

```dotenv
# ── 服务 Server ─────────────────────────────────────────────
PORT=3000
ORDER_TTL_MINUTES=15            # 待支付订单存活分钟数，超时自动过期
SHUTDOWN_TIMEOUT_MS=10000       # SIGTERM 后等待在途请求排空的最大毫秒
LOG_LEVEL=info                  # debug | info | warn | error | silent
EXPIRY_REMINDER_DAYS=3          # 订阅到期前几天发送续费提醒
PROCESSED_EVENT_TTL_DAYS=7      # 事件去重记录保留天数

# ── 持久化 Persistence ───────────────────────────────────────
# 设置后应用开机自动执行 schema.sql 迁移。🔒 含口令
DATABASE_URL=postgres://vpn_app:CHANGE_ME@db:5432/vpn_payments
# 可选：多副本分布式限流
REDIS_URL=redis://redis:6379

# ── 管理接口鉴权 Admin ───────────────────────────────────────
ADMIN_TOKEN=USE_A_LONG_RANDOM_SECRET          # 🔒 守护 /admin/*，留空则禁用 admin
ADMIN_TOKEN_PREVIOUS=                          # 🔒 轮换期临时接受的旧 token

# ── 限流 Rate limiting（按 客户端IP + 路由，固定窗口）────────
RATE_LIMIT_ENABLED=true
RATE_LIMIT_MAX=100
RATE_LIMIT_WINDOW_SEC=60

# ── HTTP 安全 Security ───────────────────────────────────────
CORS_ORIGINS=https://app.your-domain.com       # 逗号分隔；"*" 放行全部；空则关闭 CORS
REQUEST_TIMEOUT_MS=15000
MAX_BODY_BYTES=1000000
SECURITY_HEADERS=true                          # 生产保持 true

# ── 实时汇率 FX（可选，缺省用静态表）───────────────────────
FX_RATES_URL=                                  # 相对 FX_BASE 的汇率接口，可含 {base}
FX_BASE=CNY
FX_TTL_SEC=3600

# ── 出站商户 Webhook（可选）─────────────────────────────────
WEBHOOK_URL=                                   # 设置后推送签名的 order.fulfilled / refund.updated
WEBHOOK_SECRET=                                # 🔒 HMAC 签名密钥
WEBHOOK_MAX_ATTEMPTS=6                          # 死信前的投递尝试次数

# ── 计费邮件 SMTP（可选）────────────────────────────────────
SMTP_HOST=                                      # 设置 SMTP_HOST 即启用邮件
SMTP_PORT=587
SMTP_SECURE=false                               # true => 直接 TLS（如 465 端口）
SMTP_USER=                                       # 🔒
SMTP_PASS=                                       # 🔒
SMTP_FROM=no-reply@your-domain.com

# ── 微信支付 WeChat Pay v3 (Native) ─────────────────────────
# 一种支付方式仅在其必填变量齐全时才启用。
WECHAT_APP_ID=
WECHAT_MCH_ID=
# 商户 API 私钥（PEM）。单行时用字面量 \n 代表换行（见下方说明）。🔒
WECHAT_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIIEv...省略...==\n-----END PRIVATE KEY-----\n
WECHAT_SERIAL_NO=
WECHAT_API_V3_KEY=                              # 🔒 恰好 32 字符，用于解密通知
WECHAT_PLATFORM_PUBLIC_KEY=-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n
WECHAT_PLATFORM_PUBLIC_KEY_NEXT=               # 证书轮换期同时接受的新平台证书（PEM）
WECHAT_NOTIFY_URL=https://your-domain.com/api/notify/wechat
WECHAT_API_BASE=https://api.mch.weixin.qq.com

# ── 支付宝 Alipay RSA2 ──────────────────────────────────────
ALIPAY_APP_ID=
ALIPAY_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n   # 🔒 PKCS8
ALIPAY_PUBLIC_KEY=-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n      # 支付宝公钥，验签用
ALIPAY_NOTIFY_URL=https://your-domain.com/api/notify/alipay
ALIPAY_GATEWAY=https://openapi.alipay.com/gateway.do

# ── USDT (TRC20 on TRON) ────────────────────────────────────
USDT_RECEIVING_ADDRESS=                         # 你掌握私钥的收款地址
USDT_CONTRACT_ADDRESS=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t   # 省略则用官方 USDT 合约
USDT_API_BASE=https://api.trongrid.io
USDT_API_KEY=                                    # 🔒 TronGrid API Key（避免限流）
USDT_MIN_CONFIRMATIONS=19                        # 视为到账所需确认数
USDT_UNIQUE_DELTA_MAX=9999                       # 每单唯一金额微增上限（9999 = 至多 0.009999）
```

### PEM 私钥如何写入环境变量 (Embedding a PEM key)

私钥是多行文本，需压成单行、以字面量 `\n` 代表换行：

```bash
# 由 PEM 文件生成单行、\n 转义的字符串
awk 'BEGIN{ORS="\\n"}1' apiclient_key.pem
# 或
printf '%s' "$(cat apiclient_key.pem)" | sed ':a;N;$!ba;s/\n/\\n/g'
```

把输出粘贴到 `WECHAT_PRIVATE_KEY=...`（ALIPAY 私钥同理）。应用在读取时会把 `\n` 还原为真正的换行。

---

## 4. 数据库与迁移 (Database & migrations)

- **自动迁移**：当 `DATABASE_URL` 设置后，应用**开机自动执行** `src/storage/sql/schema.sql`。表结构均为 `CREATE TABLE IF NOT EXISTS`，**幂等**，重复启动安全。
- **手动执行（兜底 / fallback）**：

  ```bash
  psql "$DATABASE_URL" -f src/storage/sql/schema.sql
  ```

### 最小权限 DB 用户 (Least-privilege user)

不要用超级用户跑应用。为应用创建专用账号：

```sql
CREATE ROLE vpn_app LOGIN PASSWORD 'CHANGE_ME';
CREATE DATABASE vpn_payments OWNER vpn_app;
-- 若库已存在：
GRANT CONNECT ON DATABASE vpn_payments TO vpn_app;
\connect vpn_payments
GRANT USAGE, CREATE ON SCHEMA public TO vpn_app;      -- CREATE 供首启建表；建表后可收回 CREATE
```

### 备份 (Backups)

每日 `pg_dump` 并保留到异地存储。示例 crontab（每天 02:30）：

```cron
30 2 * * * pg_dump "postgres://vpn_app:CHANGE_ME@db:5432/vpn_payments" | gzip > /backups/vpn_payments-$(date +\%F).sql.gz
```

恢复：`gunzip -c backup.sql.gz | psql "$DATABASE_URL"`。定期演练恢复。

---

## 5. 部署方式 (Deployment options)

### (a) docker-compose 快速上手 (Quickstart)

```bash
cp .env.example .env         # 填入密钥与域名
docker compose up -d --build

# 验证
docker compose ps                         # 三个服务应为 healthy
curl -fsS http://127.0.0.1:3000/healthz   # 200
curl -fsS http://127.0.0.1:3000/readyz    # 200，DB+Redis 就绪
curl -fsS http://127.0.0.1:3000/version
```

compose 会自动设置容器内 `DATABASE_URL`（指向 `db`）与 `REDIS_URL`（指向 `redis`），首启自动迁移。
生产仍需在 `app` 前置反向代理终结 TLS（见 §6）。

### (b) Kubernetes / Helm

- Helm chart：`deploy/helm/vpn-payment`
- 原生清单：`deploy/k8s/*`

```bash
helm upgrade --install vpn-payment deploy/helm/vpn-payment \
  --set replicaCount=2 \
  --set env.DATABASE_URL="postgres://..." \
  --set env.REDIS_URL="redis://..."
# 或
kubectl apply -f deploy/k8s/
```

**多副本要点 (≥2 replicas)**：
- 订单/事件**去重走 DB**，已跨实例安全 —— 天然一致。
- **进程内限流器是每实例独立的**；要让全局限流准确，必须给所有副本配置**同一个 `REDIS_URL`**。
- 配置 readiness 探针指向 `/readyz`，liveness 指向 `/healthz`。

---

## 6. 反向代理 / TLS (Reverse proxy)

应用只提供明文 HTTP，由前置代理在 443 终结 TLS。最小 nginx 配置：

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    # 建议：公网部署时屏蔽文档端点（见 §8）
    location ~ ^/(docs|openapi\.json)$ { return 404; }

    location / {
        proxy_pass         http://app:3000;      # 或 http://127.0.0.1:3000
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   X-Request-Id      $request_id;   # 透传/生成请求 ID
        proxy_read_timeout 30s;
    }
}

# HTTP → HTTPS 跳转
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}
```

- 让应用能拿到真实客户端 IP，务必转发 `X-Forwarded-For`（限流按 IP）。
- 相应设置应用侧 `CORS_ORIGINS`（如 `https://app.your-domain.com`），不要在生产用 `*`。

---

## 7. 支付渠道回调配置 (Provider callback setup)

| 渠道 | 回调方式 | 需登记的 URL |
|---|---|---|
| 微信 WeChat | 平台**推送** POST | `https://<domain>/api/notify/wechat` |
| 支付宝 Alipay | 平台**推送** POST | `https://<domain>/api/notify/alipay` |
| USDT | 应用**轮询**，**无回调** | —（见下） |

- **微信**：在商户平台登记的回调 URL 必须与环境变量 `WECHAT_NOTIFY_URL` **完全一致**，且为公网 HTTPS。应用用 APIv3 密钥解密、用平台证书验签。
- **支付宝**：`ALIPAY_NOTIFY_URL` 必须与实际登记/请求中携带的 notify URL **完全一致**，公网 HTTPS，用支付宝公钥验签。
- **USDT（无推送）**：两种对账模式，由 `USDT_ADDRESS_MODE` 选择：
  - `shared`（默认）：**共享收款地址 + 唯一金额匹配**。所有订单收到同一个 `USDT_RECEIVING_ADDRESS`，应用为每单在金额上追加一个微小唯一增量（上限 `USDT_UNIQUE_DELTA_MAX`）以区分订单。
  - `per-order`：**每单独立地址 + 二次归集**（见 §7.1）。
  - 两种模式都靠轮询 TronGrid，达到 `USDT_MIN_CONFIRMATIONS`（默认 19）确认后判定到账。建议配置 `USDT_API_KEY` 以避免 TronGrid 公共限流。

### 7.1 USDT 独立地址与二次归集 (per-order deposit + sweep)

设 `USDT_ADDRESS_MODE=per-order` 后，每个 USDT 订单由 HD 钱包（`USDT_HD_MNEMONIC`）在唯一索引处派生**专属充值地址**，按**地址**（而非金额）匹配到账。订单结算后，持久化的归集状态机把资金归集到中心钱包 `USDT_COLLECTION_ADDRESS`：

```
PENDING ──▶ GAS_FUELING ──▶ SWEEPING ──▶ SWEPT
   │  (充值地址无 TRX，先从费用钱包打 gas)   │
   └──▶ EMPTY(低于粉尘阈值)      失败重试用尽 ──▶ FAILED
```

关键点与前置条件：
- 需要 `npm install tronweb`（可选依赖，仅 per-order 模式加载）。TRON 加解密/签名由该适配器完成。
- **两个热钱包密钥**（务必放入密钥管理，勿明文入库/入 env 常驻）：
  - `USDT_HD_MNEMONIC` 🔒 —— 派生充值地址并在归集时重新派生私钥签名。
  - `USDT_FEE_PRIVATE_KEY` 🔒 —— **费用钱包**，需常备充足 TRX 为每个新充值地址补 gas（`USDT_GAS_TOPUP_SUN`，默认 15 TRX/单）。**费用钱包 TRX 耗尽会导致归集停滞**——纳入余额告警。
    - **固定地址补 gas**：补 gas 永远从这个（或这些）**固定的费用钱包**发起，绝不使用临时/随机地址；充值地址无需预先充 TRX，归集钱包只收不发。
    - **费用钱包池（可选一个或几个）**：用 `USDT_FEE_PRIVATE_KEYS`（逗号分隔多个）替代单个 `USDT_FEE_PRIVATE_KEY`，补 gas 会在这几个固定地址间 **轮询（round-robin）**，以规避单地址限流/交易冲突并分散热钱包风险。`vpn_fee_wallet_trx_sun` 上报**池内总余额**——多钱包时把 `USDT_FEE_WALLET_MIN_SUN` 设为 ≈N×单钱包期望余量。
- `USDT_COLLECTION_ADDRESS` 建议为**冷钱包/多签**，仅收不发。
- 粉尘阈值 `USDT_SWEEP_MIN_MICRO`（默认 1 USDT）以下不归集；`USDT_SWEEP_MAX_ATTEMPTS`/`USDT_SWEEP_BACKOFF_SEC` 控制重试。
- 归集为幂等、断点续跑：崩溃/重启后各任务从其持久化状态继续；`FAILED` 任务需人工介入（查 `sweep_jobs.last_error`）。
- 多副本安全：任务持久化于 DB，`sweep_jobs` 唯一约束保证每单一份；启用 `DATABASE_URL` 即跨实例安全。

**监控与运维（observability & ops）**：
- 指标（`/metrics`）：`vpn_sweep_jobs{status}`、`vpn_sweep_pending`、`vpn_sweep_failed`、`vpn_sweep_amount_micro_total`（已归集总额）、`vpn_fee_wallet_trx_sun`（费用钱包余额）。
- 告警：出现 `FAILED` 归集（critical）或费用钱包低于 `USDT_FEE_WALLET_MIN_SUN`（默认 10×gas 单笔）时自动告警（走 `alertSink`，同 reconciliation/DLQ 通道）。**务必为 `vpn_fee_wallet_trx_sun` 配 Prometheus 告警规则。**
- 运维接口（需 `ADMIN_TOKEN`）：`GET /admin/sweeps?status=FAILED` 查看卡住的归集；补足费用钱包后 `POST /admin/sweeps/<orderId>/retry` 重新入队。

---

## 8. 上线验收清单 (Go-live checklist)

按顺序逐项确认：

1. `[ ]` `GET /healthz` 返回 **200**（liveness）。
2. `[ ]` `GET /readyz` 返回 **200**，DB 与 Redis 均 green（未配置 Redis 时仅校验 DB）。
3. `[ ]` `GET /metrics` 可被 Prometheus 抓取。
4. `[ ]` `GET /docs` 与 `/openapi.json` 仅内网可达；**公网部署建议在代理层屏蔽或加鉴权**（见 §6 的 `location`）。
5. `[ ]` 每种支付方式各下一笔**小额真实订单**端到端跑通：`POST /api/orders` → 支付 → 确认结算（微信/支付宝回调到账，USDT 轮询到账）→ 商户 webhook 收到 `order.fulfilled`。
6. `[ ]` 验证**退款**流程（发起退款，`GET /api/orders/:id` 状态更新，收到 `refund.updated`）。
7. `[ ]` 验证 **admin 鉴权**：无 `ADMIN_TOKEN` 时 `/admin/*` 返回 401/403；带正确 token 通过。
8. `[ ]` 验证**限流**：超过 `RATE_LIMIT_MAX` 后返回 **429**（多副本时确认走 Redis 全局计数）。
9. `[ ]` 验证**优雅停机**：发送 SIGTERM，在途请求在 `SHUTDOWN_TIMEOUT_MS` 内排空后退出，无连接被硬切。

---

## 9. 监控与告警 (Observability)

- 用 Prometheus 抓取 `GET /metrics`（应用暴露 Prometheus 文本格式指标）。
- 导入随仓库提供的 Grafana 面板与告警规则 —— 参见仓库中的 metrics/alerts 资产（`monitoring/`、`deploy/` 下的观测性资源）。
- 重点关注：
  - **死信 webhook 数**（投递失败进入死信，达 `WEBHOOK_MAX_ATTEMPTS` 后停投）。
  - **对账告警 / reconciliation**（订单状态与链上/渠道不一致）。
  - `/readyz` 抖动、5xx 率、限流 429 率、TronGrid 轮询错误率。

---

## 10. 安全加固 (Security hardening)

- **强 `ADMIN_TOKEN`**：足够长的随机串；轮换时先把旧值写入 `ADMIN_TOKEN_PREVIOUS`、更新 `ADMIN_TOKEN`，过渡期后清空 previous。
- **密钥来自密钥管理器**：生产用 Vault / KMS / K8s Secret，而非明文 `.env`；勿入库、勿打日志。
- **网络隔离**：`/admin/*` 与 `/docs`、`/openapi.json` 仅限内网/白名单访问。
- **保持 `SECURITY_HEADERS=true`**。
- **显式 `CORS_ORIGINS`**：只列可信前端域名，勿用 `*`。
- **前置 WAF / 边缘限流**，与应用内限流叠加防护。
- **最小权限 DB 用户**（见 §4）。
- **定期密钥轮换**：微信平台证书轮换时把新证书填入 `WECHAT_PLATFORM_PUBLIC_KEY_NEXT`，新旧同时验签，切换后再收回旧证书；同理定期轮换 API 私钥、APIv3 密钥、`WEBHOOK_SECRET`。

---

## 11. 回滚 (Rollback)

- **镜像固定 tag**：始终部署带明确版本 tag 的镜像，勿依赖 `latest`。
- docker-compose：

  ```bash
  # 在 .env / compose 中把 app 指向上一个已知良好镜像 tag，然后
  docker compose up -d
  ```

- Kubernetes：

  ```bash
  kubectl rollout undo deployment/vpn-payment
  # 或 helm rollback vpn-payment <REVISION>
  ```

- **数据库安全**：迁移是**增量式**（`CREATE TABLE IF NOT EXISTS`），不删列/不破坏旧结构，因此**回滚应用版本是安全的**，无需回退 DB。

---

## 12. 常见问题 (Troubleshooting)

| 现象 Symptom | 可能原因与排查 Likely cause & fix |
|---|---|
| 回调**验签失败** signature failure | 服务器**时钟偏移**（校准 NTP）；**平台证书/公钥不对**（微信平台证书、支付宝公钥）；**APIv3 密钥错误或非 32 位**；登记的 notify URL 与 `*_NOTIFY_URL` 不一致。 |
| `/readyz` 返回 **503** | DB 或 Redis 不可达 —— 检查 `DATABASE_URL`/`REDIS_URL`、网络与凭据、实例是否存活。 |
| 订单长期 **PENDING** | 回调 URL **公网不可达**（代理/防火墙/证书）；登记的 notify URL 与 `WECHAT_NOTIFY_URL`/`ALIPAY_NOTIFY_URL` **不一致**；渠道侧未回调。 |
| **USDT 不匹配** not matching | 确认数未达 `USDT_MIN_CONFIRMATIONS`（默认 19，需等待）；付款金额未精确匹配唯一金额（用户改动了小数）；`USDT_UNIQUE_DELTA_MAX` 太小导致金额冲突；TronGrid **缺少 `USDT_API_KEY` 被限流** 或 `USDT_API_BASE` 配置错误；合约地址 `USDT_CONTRACT_ADDRESS` 不正确。 |
| 限流不生效 / 计数偏差（多副本）| 各副本未共享 `REDIS_URL`，退化为每实例计数 —— 统一配置同一 Redis。 |
| 拿不到真实客户端 IP | 代理未转发 `X-Forwarded-For`，或未信任代理头 —— 修正反向代理配置（见 §6）。 |
