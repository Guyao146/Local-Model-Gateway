# 认证与安全

## 双轨认证模型

网关把「管理面」与「模型调用面」完全分开：

| 面 | 接口 | 认证 | 说明 |
| --- | --- | --- | --- |
| 管理面 | `/api/admin/*`、后台页面 | 回环免认证 / 远程 Authentik OIDC | 管理凭据与模型调用无关 |
| 调用面 | `/v1/*` | 本地 API Key | 无论本机还是远程都要 Key |

默认只监听 `127.0.0.1`，避免未经配置直接暴露到局域网。

## 来源识别（`admin-auth.js`）

- `normalizeAddress`：归一化 IPv4-mapped（`::ffff:x`）、IPv6 zone（`%`）、括号包裹地址。
- `isLoopbackAddress`：`::1` 及 `127.x.x.x` 判为回环。
- `requestSource`：默认**只信任 TCP socket 地址**，不信任客户端发来的 `X-Forwarded-For`。
  本机回环地址若携带转发头会标记 `untrustedForwarding: true` 并按非回环处理（防伪造）。
- 反向代理场景：把代理实际连接网关的 IP 加入 `TRUSTED_PROXY_ADDRESSES`
  （逗号分隔的精确 IP 列表），此时网关才会解析转发头，且会从右向左找到第一个非可信 IP
  作为真实来源。

## Authentik OIDC 流程

1. 未认证的远程访问重定向到 Authentik 登录页（`/auth/oidc/login`）。
2. 使用 **Authorization Code + PKCE**，并携带 `state` 与 `nonce`（交易 Cookie
   `lmg_oidc_state`，10 分钟有效）。
3. 回调 `/auth/oidc/callback` 校验：discovery、issuer、audience、过期时间（含 60s 时钟容差）、
   `state`/`nonce`/PKCE，以及通过 **JWKS 对 ID Token 做非对称签名校验**。
4. 校验通过后创建随机 32 字节的会话 ID，写入 **HttpOnly** Cookie
   （`lmg_admin_session`），有效期 = `min(claims.exp, now + SESSION_TTL)`。
5. 会话只存在服务端内存（`Map`），**服务重启后远程会话全部失效**，需重新登录。

安全细节：

- Client Secret 只从环境变量读取，**不写入 `data/config.json` 或 Git**。
- Token 端点鉴权默认按 discovery 自动选择 `client_secret_basic` / `client_secret_post`。
- 签名校验要求非对称签名 JWT；**不支持加密的 JWE ID Token**（Authentik 不要配 Encryption Key）。
- `TRANSACTION_TTL_MS = 10min`、`DISCOVERY_TTL_MS = 1h`（discovery 有缓存）。
- 登出：清会话并调用 Authentik `end_session_endpoint`（带 `id_token_hint`）。

## 本地 API Key

- 创建于后台，`sk-local_<随机>` 格式；可重命名、启用/停用。
- 停用立即生效（模型请求返回 401）；**系统至少保留一个可管理的 Key**，不允许删除最后一个。
- 完整 Key 只在已认证的管理后台可见/可复制；上游 API Key 始终掩码显示
  （`maskSecret`：保留首尾各 4 字符，其余打点）。

## 限流与并发

- 全局并发上限 `maxConcurrentRequests`（0 不限）。
- 每 Key 每分钟请求上限 `requestsPerMinute`（0 不限）。
- 被拒请求返回 `429` + `Retry-After` + `x-request-id`，不消耗并发槽与每分钟配额。
- 仅作用于模型调用接口，不影响 `/v1/models` 与管理接口。

## 数据文件安全

| 文件 | 敏感程度 | 保护方式 |
| --- | --- | --- |
| `data/config.json` | 含上游/本地 Key | 0600 权限、原子写（`.tmp` + rename）、已 `.gitignore` |
| `data/metrics.json` | 脱敏元数据 | 0600、已 `.gitignore` |
| `data/metrics-log.jsonl` | 脱敏元数据 | 0600、追加写入、已 `.gitignore` |
| Authentik Client Secret | 高 | 仅环境变量，永不落盘 |

> ℹ️ `.gitignore` 覆盖 `data/config.json`、`data/metrics.json`、`data/metrics-log.jsonl`、
> `data/*.tmp` 与 `*.log`，运行时数据不会被误提交。

## 反向代理与 HTTPS

- 使用 `HOST=0.0.0.0` 暴露时：远程管理访问必须完整配置 Authentik；模型接口仍需本地 Key。
- 建议同时使用 HTTPS、防火墙与网络访问控制。
- 若经 Nginx/Caddy/Traefik 反代：把代理 IP 加入 `TRUSTED_PROXY_ADDRESSES`；
  会话 Cookie 的 `Secure` 属性按回调 URL 是否 HTTPS 自动决定，生产环境不要强制关闭。
